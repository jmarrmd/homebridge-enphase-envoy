/**
 * envoyclient.js
 *
 * Minimal read-only HTTP client for an Enphase Envoy / IQ Gateway.
 *
 * It does exactly two things:
 *   1. authenticate (JWT for firmware v7+, no auth or Digest for older), and
 *   2. read whole-system solar production and home consumption.
 *
 * Everything else the gateway exposes — inverters, batteries, Ensemble, grid
 * profiles, meter configuration — is deliberately out of scope.
 */

import axios from 'axios';
import { Agent } from 'https';
import EventEmitter from 'events';
import { promises as fsPromises } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import DigestAuth from './digestauth.js';
import EnvoyToken from './envoytoken.js';
import { ApiUrls, Authorization, PartNumbers, MeasurementKind } from './constants.js';

const REQUEST_TIMEOUT = 15_000;

/** Re-mint a JWT this many seconds before it actually expires. */
const TOKEN_RENEW_MARGIN = 3600;

/** Token generation modes, mirroring the values used by the config schema. */
export const TokenMode = {
    None: 0,        // firmware < v7 — no token
    Enlighten: 1,   // mint a token from Enlighten credentials
    Supplied: 2     // use a token pasted into the config
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Coerce to a finite number, or null when the gateway omitted the field. */
const num = (value) => (isNumber(value) ? value : (isNumber(Number(value)) ? Number(value) : null));

class EnvoyClient extends EventEmitter {
    constructor(config) {
        super();

        this.host = config.host;
        this.tokenMode = config.tokenMode ?? TokenMode.None;
        this.enlightenUser = config.enlightenUser;
        this.enlightenPasswd = config.enlightenPasswd;
        this.suppliedToken = config.envoyToken;
        this.envoyPasswd = config.envoyPasswd;
        this.tokenFile = config.tokenFile;

        this.info = null;
        this.token = null;
        this.cookie = null;
        this.digestAuth = null;

        // Gateways served over https present a self-signed certificate.
        this.httpsAgent = new Agent({ keepAlive: false, rejectUnauthorized: false });

        // Lifetime energy counters must never go backwards: Matter treats
        // cumulative energy as monotonic, and a momentary dip in a gateway
        // reading would otherwise show up as a bogus spike in the Home app.
        this.energyFloor = {
            [MeasurementKind.Production]: 0,
            [MeasurementKind.Consumption]: 0
        };

        // Chosen during connect(): https for token firmware, http otherwise.
        this.url = this.tokenMode > TokenMode.None ? `https://${this.host}` : `http://${this.host}`;
    }

    // ── Connection ─────────────────────────────────────────────────────────────

    /**
     * Read /info.xml, then authenticate. Returns the parsed device info.
     * Throws on any failure so the caller can retry the whole cycle.
     */
    async connect() {
        this.info = await this.getInfo();

        const tokenRequired = this.info.webTokens || this.tokenMode > TokenMode.None;
        if (tokenRequired) {
            await this.authorizeToken();
        } else {
            this.authorizeDigest();
        }

        return this.info;
    }

    /**
     * Fetch and parse /info.xml.
     *
     * The scheme depends on firmware, which is exactly what this endpoint tells
     * us — so on failure retry with the other scheme rather than making the user
     * get `envoyFirmware7xxTokenGenerationMode` right just to be reachable.
     */
    async getInfo() {
        const schemes = this.url.startsWith('https') ? ['https', 'http'] : ['http', 'https'];
        let lastError;

        for (const scheme of schemes) {
            const url = `${scheme}://${this.host}`;
            try {
                const response = await axios.get(`${url}${ApiUrls.GetInfo}`, {
                    timeout: REQUEST_TIMEOUT,
                    httpsAgent: this.httpsAgent
                });

                this.url = url;
                return this.parseInfo(response.data);
            } catch (error) {
                lastError = error;
            }
        }

        throw new Error(`Read ${ApiUrls.GetInfo} from ${this.host} failed: ${lastError?.message ?? lastError}`);
    }

    parseInfo(xmlString) {
        const parser = new XMLParser({
            ignoreAttributes: false,
            ignorePiTags: true,
            allowBooleanAttributes: true
        });
        const parsed = parser.parse(xmlString);

        const envoyInfo = parsed.envoy_info ?? {};
        const device = envoyInfo.device ?? {};

        const serialNumber = device.sn?.toString();
        if (!serialNumber) {
            throw new Error('Envoy serial number missing from info.xml');
        }

        // "7.6.175" -> 76 ... "8.2.4127" -> 824. Unknown firmware sorts as legacy.
        const digits = (device.software?.toString() ?? '').replace(/\D/g, '');
        const firmware = digits ? parseInt(digits.slice(0, 3), 10) : 0;

        return {
            serialNumber,
            partNumber: device.pn,
            modelName: PartNumbers[device.pn] ?? device.pn ?? 'IQ Gateway',
            software: device.software?.toString(),
            firmware,
            meters: !!device.imeter,
            webTokens: !!envoyInfo['web-tokens']
        };
    }

    // ── Authentication ─────────────────────────────────────────────────────────

    /** Obtain a JWT (from config, cache, or Enlighten) and validate it. */
    async authorizeToken() {
        if (this.tokenMode === TokenMode.Supplied) {
            if (!this.suppliedToken) {
                throw new Error('Token generation mode is "token" but no token is configured');
            }
            this.token = { token: this.suppliedToken };
        } else {
            this.token = await this.loadCachedToken() ?? await this.mintToken();
        }

        await this.validateToken();
    }

    /** A cached token is only worth reusing while it has real life left in it. */
    async loadCachedToken() {
        if (!this.tokenFile) return null;

        try {
            const raw = await fsPromises.readFile(this.tokenFile, 'utf8');
            if (!raw.trim()) return null;

            const cached = JSON.parse(raw);
            const now = Math.floor(Date.now() / 1000);
            if (!cached.token || !isNumber(cached.expires_at) || cached.expires_at < now + TOKEN_RENEW_MARGIN) {
                return null;
            }

            this.emit('debug', `Reusing cached token, expires ${new Date(cached.expires_at * 1000).toLocaleString()}`);
            return cached;
        } catch (error) {
            this.emit('debug', `Cached token unusable: ${error.message ?? error}`);
            return null;
        }
    }

    async mintToken() {
        if (!this.enlightenUser || !this.enlightenPasswd) {
            throw new Error('Enlighten credentials are required to generate a token');
        }

        const envoyToken = new EnvoyToken({
            user: this.enlightenUser,
            passwd: this.enlightenPasswd,
            serialNumber: this.info.serialNumber,
            logWarn: true,
            logError: true
        })
            .on('success', (message) => this.emit('success', message))
            .on('warn', (message) => this.emit('warn', message))
            .on('error', (message) => this.emit('error', message));

        const tokenData = await envoyToken.refreshToken();
        if (!tokenData?.token) {
            throw new Error('Enlighten returned no token');
        }

        if (this.tokenFile) {
            try {
                await fsPromises.writeFile(this.tokenFile, JSON.stringify(tokenData, null, 2));
            } catch (error) {
                this.emit('warn', `Could not cache token: ${error.message ?? error}`);
            }
        }

        return tokenData;
    }

    /**
     * Exchange the JWT for a session cookie. The gateway accepts the bearer
     * token on its own, but the cookie is what keeps subsequent requests cheap.
     */
    async validateToken() {
        const response = await axios.get(`${this.url}${ApiUrls.CheckJwt}`, {
            headers: { Authorization: `Bearer ${this.token.token}` },
            timeout: REQUEST_TIMEOUT,
            httpsAgent: this.httpsAgent
        });

        const body = response.data;
        if (typeof body !== 'string' || !body.includes('Valid token')) {
            throw new Error(`Token rejected by the gateway: ${body}`);
        }

        this.cookie = response.headers['set-cookie'] ?? null;
        this.emit('success', 'Token validated');
    }

    /**
     * Firmware < v7 serves /production.json unauthenticated on most gateways.
     * Prepare Digest credentials anyway so a gateway that does challenge us can
     * be answered without a second round of configuration.
     */
    authorizeDigest() {
        const passwd = this.envoyPasswd || this.info.serialNumber.slice(-6);
        this.digestAuth = new DigestAuth({ user: Authorization.EnvoyUser, passwd });
    }

    // ── Requests ───────────────────────────────────────────────────────────────

    /**
     * GET a JSON endpoint, re-authenticating once on 401. Token sessions expire
     * and legacy gateways may challenge mid-run; either way one retry with fresh
     * credentials is enough.
     */
    async get(path, { retryOnUnauthorized = true } = {}) {
        try {
            return await this.rawGet(path);
        } catch (error) {
            if (!retryOnUnauthorized || error.response?.status !== 401) throw error;

            this.emit('debug', `Unauthorized on ${path}, re-authenticating`);

            if (this.token) {
                // The cached token may itself be stale, so mint a new one.
                this.token = this.tokenMode === TokenMode.Supplied ? this.token : await this.mintToken();
                await this.validateToken();
            } else if (this.digestAuth) {
                this.digestAuth.count = 0;
            }

            return await this.rawGet(path);
        }
    }

    async rawGet(path) {
        const headers = { Accept: 'application/json' };
        if (this.token) headers.Authorization = `Bearer ${this.token.token}`;
        if (this.cookie) headers.Cookie = this.cookie;

        const options = {
            method: 'GET',
            baseURL: this.url,
            headers,
            timeout: REQUEST_TIMEOUT,
            httpsAgent: this.httpsAgent
        };

        // DigestAuth transparently answers a 401 challenge and replays the request.
        const response = this.digestAuth
            ? await this.digestAuth.request(path, options)
            : await axios.request({ url: `${this.url}${path}`, ...options });

        return response.data;
    }

    // ── Readings ───────────────────────────────────────────────────────────────

    /**
     * Read current production and consumption.
     *
     * @returns {Promise<{production: object|null, consumption: object|null}>}
     *          Each reading is `{ power, energyLifetime, voltage, current }` in
     *          W / Wh / V / A, or null when the gateway does not report it.
     */
    async readEnergy() {
        let stats = null;
        try {
            stats = await this.get(ApiUrls.SystemReadingStats);
        } catch (error) {
            this.emit('debug', `${ApiUrls.SystemReadingStats} unavailable (${error.message ?? error}), falling back`);
        }

        const production = this.parseProduction(stats)
            ?? await this.readProductionFallback();
        const consumption = this.parseConsumption(stats, production);

        return {
            production: this.applyEnergyFloor(MeasurementKind.Production, production),
            consumption: this.applyEnergyFloor(MeasurementKind.Consumption, consumption)
        };
    }

    /**
     * Production comes from either the production CT ("eim") or, on a gateway
     * without CTs, the microinverters' own reports ("inverters"). The CT is the
     * better source when it is actually installed and reporting.
     */
    parseProduction(stats) {
        const entries = Array.isArray(stats?.production) ? stats.production : [];

        const eim = entries.find((entry) => entry?.type === 'eim' && (entry.activeCount ?? 0) > 0);
        if (eim) return this.toReading(eim);

        const pcu = entries.find((entry) => entry?.type === 'inverters');
        return pcu ? this.toReading(pcu) : null;
    }

    /**
     * Home consumption is the "total-consumption" CT when the gateway has one.
     * A gateway wired for net metering only reports "net-consumption" (what
     * crosses the meter), so reconstruct the house load as production + net.
     */
    parseConsumption(stats, production) {
        const entries = Array.isArray(stats?.consumption) ? stats.consumption : [];

        const total = entries.find((entry) => entry?.measurementType === 'total-consumption');
        if (total) return this.toReading(total);

        const net = entries.find((entry) => entry?.measurementType === 'net-consumption');
        if (!net || !production) return null;

        const netReading = this.toReading(net);
        return {
            power: this.addOrNull(production.power, netReading.power),
            energyLifetime: this.addOrNull(production.energyLifetime, netReading.energyLifetime),
            voltage: netReading.voltage,
            current: null
        };
    }

    /** /api/v1/production — production only, available on every firmware. */
    async readProductionFallback() {
        try {
            const data = await this.get(ApiUrls.Production);
            if (!isNumber(data?.wattsNow)) return null;

            return {
                power: data.wattsNow,
                energyLifetime: num(data.wattHoursLifetime),
                voltage: null,
                current: null
            };
        } catch (error) {
            this.emit('debug', `${ApiUrls.Production} unavailable: ${error.message ?? error}`);
            return null;
        }
    }

    /**
     * Normalize one production.json entry.
     *
     * Lifetime energy is taken from the entry total, falling back to summing the
     * per-line values on gateways that only populate `lines`.
     */
    toReading(entry) {
        const lines = Array.isArray(entry.lines) ? entry.lines : [];
        const lineTotal = lines.reduce((sum, line) => sum + (num(line?.whLifetime) ?? 0), 0);
        const whLifetime = num(entry.whLifetime);

        return {
            power: num(entry.wNow),
            energyLifetime: whLifetime ?? (lines.length ? lineTotal : null),
            voltage: num(entry.rmsVoltage),
            current: num(entry.rmsCurrent)
        };
    }

    addOrNull(a, b) {
        return isNumber(a) && isNumber(b) ? a + b : null;
    }

    /** Hold cumulative energy at its high-water mark. See `energyFloor`. */
    applyEnergyFloor(kind, reading) {
        if (!reading) return null;

        const floor = this.energyFloor[kind];
        if (!isNumber(reading.energyLifetime)) {
            return { ...reading, energyLifetime: floor || null };
        }

        const energyLifetime = Math.max(reading.energyLifetime, floor);
        this.energyFloor[kind] = energyLifetime;
        return { ...reading, energyLifetime };
    }
}

export default EnvoyClient;
