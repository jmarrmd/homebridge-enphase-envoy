/**
 * envoyclient.js
 *
 * Minimal read-only HTTP client for an Enphase Envoy / IQ Gateway.
 *
 * It does exactly two things:
 *   1. authenticate (JWT for firmware v7+, no auth or Digest for older), and
 *   2. read whole-system solar production, home consumption and grid flow.
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
import GridEnergy from './gridenergy.js';
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

        // Grid import/export has to be accumulated as we watch — see gridenergy.js.
        this.gridEnergy = config.gridFile
            ? new GridEnergy({ file: config.gridFile, maxGapMs: config.gridMaxGapMs })
            : null;
        this.warnedGridSave = false;

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

        // The register each measurement's lifetime energy was first read from.
        // A gateway offers the same quantity from several counters with
        // different values; switching between them steps a monotonic total.
        // See pinEnergySource().
        this.energySource = {
            [MeasurementKind.Production]: null,
            [MeasurementKind.Consumption]: null
        };
        this.warnedEnergySource = {};

        // Chosen during connect(): https for token firmware, http otherwise.
        this.url = this.tokenMode > TokenMode.None ? `https://${this.host}` : `http://${this.host}`;
    }

    // ── Connection ─────────────────────────────────────────────────────────────

    /**
     * Read /info.xml, then authenticate. Returns the parsed device info.
     * Throws on any failure so the caller can retry the whole cycle.
     */
    async connect() {
        if (this.gridEnergy) {
            const { status, error } = await this.gridEnergy.load();
            if (status === 'unreadable') {
                this.emit('warn', `Stored grid energy counters could not be read (${error}). Import and export restart from zero, so the Home app may ignore grid energy until each counter passes its previous total.`);
            } else {
                this.emit('debug', status === 'restored'
                    ? 'Restored grid energy counters from disk'
                    : 'No stored grid energy counters, starting from zero');
            }
        }

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
     * Hold each measurement's cumulative energy to the register it was first
     * read from.
     *
     * A gateway offers the same quantity from several counters, and this plugin
     * picks between them per reading: production can come from the CT entry's
     * own total, from the sum of that entry's lines, from the microinverters'
     * self-reports, or from `/api/v1/production`. Those are four different
     * registers with four different values. Switching between them mid-run
     * steps a monotonic counter by the difference — and the high-water floor
     * does not catch it, because it clamps decreases and a switch upward is an
     * increase.
     *
     * That was survivable while each sensor only published its own register.
     * Grid energy is now `consumption - production`, so a step in either lands
     * straight in the grid counters, one-directionally: production jumping up
     * reads as energy exported. Overnight, when the CT's reporting state
     * changes, that is a large export that never happened.
     *
     * So the source is pinned. Power still comes from whichever entry is
     * reporting — it is instantaneous and switching is fine — but the lifetime
     * register does not move. If the pinned one stops being offered, this
     * reports no energy rather than a different counter's, and the floor holds
     * the last value until it returns.
     *
     * @param {string} kind one of MeasurementKind
     * @param {object|null} reading
     */
    pinEnergySource(kind, reading) {
        if (!reading) return reading;

        const source = reading.energySource ?? null;
        const pinned = this.energySource[kind];

        if (!pinned) {
            if (source) this.energySource[kind] = source;
            return reading;
        }
        if (!source || source === pinned) return reading;

        if (!this.warnedEnergySource[kind]) {
            this.warnedEnergySource[kind] = true;
            this.emit('warn', `${kind} lifetime energy is being offered by "${source}" instead of "${pinned}", which this reading was pinned to. Those are different registers on the gateway, and taking the new one would step a counter that may never go backwards. Holding the last known value instead. If the gateway has genuinely lost "${pinned}", restart to re-pin.`);
        }
        return { ...reading, energyLifetime: null };
    }

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

        // Floored before the grid sees them. Grid energy is now the *difference*
        // between these two registers, so a momentary dip in either would read
        // as flow that never happened — credited to one direction on the dip and
        // to the other on the recovery, inflating both counters permanently.
        // The high-water mark holds them monotonic, which is exactly what makes
        // the difference trustworthy.
        const production = this.applyEnergyFloor(
            MeasurementKind.Production,
            this.pinEnergySource(MeasurementKind.Production, this.parseProduction(stats) ?? await this.readProductionFallback())
        );
        const consumption = this.applyEnergyFloor(
            MeasurementKind.Consumption,
            this.pinEnergySource(MeasurementKind.Consumption, this.parseConsumption(stats, production))
        );

        return {
            production,
            consumption,
            grid: this.readGrid(stats, production, consumption)
        };
    }

    /**
     * Grid flow: what actually crosses the service entrance.
     *
     * Neither production nor house load answers this on its own — solar consumed
     * on site never touches the grid — so without this a controller has no way to
     * work out grid use.
     *
     * Power comes from the net-consumption CT where the gateway has one, since
     * that is a direct measurement; otherwise it is derived as load minus
     * production, which is the same quantity by conservation.
     *
     * Energy no longer comes from that power. House load minus production, both
     * read from the gateway's own accumulated registers, is the net energy that
     * crossed the service entrance — measured, not estimated — and `GridEnergy`
     * sorts each increment into a direction. Integrating `wNow` is unbounded and
     * a single transient reading of a few hundred kW fabricates tens of kWh; a
     * register cannot do that.
     *
     * The subtraction only says something when house load was *measured*. Where
     * it was reconstructed as production plus net, it collapses back to the
     * gateway's own signed net register, so there is nothing to gain and the
     * integrated path is used instead.
     *
     * @returns {object|null} `{ power, energyImported, energyExported, voltage }`
     */
    readGrid(stats, production, consumption) {
        if (!this.gridEnergy) return null;

        const entries = Array.isArray(stats?.consumption) ? stats.consumption : [];
        const net = entries.find((entry) => entry?.measurementType === 'net-consumption');

        const measured = net ? this.toReading(net, 'net-consumption') : null;
        const power = measured && isNumber(measured.power)
            ? measured.power
            : this.subtractOrNull(consumption?.power, production?.power);

        const netEnergy = this.consumptionMeasured
            ? this.subtractOrNull(consumption?.energyLifetime, production?.energyLifetime)
            : null;

        if (!isNumber(power) && !isNumber(netEnergy)) return null;

        const { imported, exported } = this.gridEnergy.sample({ netEnergy, power });
        this.reportGridSource();

        return {
            power,
            energyImported: imported,
            energyExported: exported,
            voltage: measured?.voltage ?? null,
            current: null
        };
    }

    /**
     * Say once which source the grid counters are running on, and speak up
     * every time an increment is refused.
     *
     * Which path is in use changes what the numbers mean and how much to trust
     * them, and nothing else in the log would reveal it.
     */
    reportGridSource() {
        const source = this.gridEnergy.source;
        if (source && source !== this.reportedGridSource) {
            this.reportedGridSource = source;
            this.emit('info', source === 'measured'
                ? 'Grid energy is measured: house load minus production, from the gateway\'s own registers. Increments carry across restarts, and a transient power reading cannot inflate them.'
                : 'Grid energy is integrated from instantaneous power, because house load is reconstructed rather than measured on this gateway (no total-consumption CT). It approximates at the polling rate and cannot cover time the plugin was stopped.');
        }

        const skipped = this.gridEnergy.takeSkipped();
        if (!skipped) return;

        this.emit('warn', `Refused a grid energy increment of ${skipped.delta.toFixed(1)} Wh over ${Math.round(skipped.elapsed / 1000)} s — an implied ${Math.round(skipped.implied)} W, which is not load. The gateway's registers stepped rather than counted. That interval is not recorded; the counters keep the value they had.`);
    }

    /** Persist the grid counters so a restart does not rewind them. */
    async saveGridEnergy() {
        if (!this.gridEnergy) return;

        const error = await this.gridEnergy.save();
        if (!error) return;

        // Warn once, then debug. A failing save repeats every poll, and the
        // consequence — a rewind on the next restart — is the same each time.
        const message = `Could not save grid energy counters: ${error}`;
        if (this.warnedGridSave) {
            this.emit('debug', message);
        } else {
            this.warnedGridSave = true;
            this.emit('warn', message);
        }
    }

    /**
     * Production comes from either the production CT ("eim") or, on a gateway
     * without CTs, the microinverters' own reports ("inverters"). The CT is the
     * better source when it is actually installed and reporting.
     */
    parseProduction(stats) {
        const entries = Array.isArray(stats?.production) ? stats.production : [];

        const eim = entries.find((entry) => entry?.type === 'eim' && (entry.activeCount ?? 0) > 0);
        if (eim) return this.toReading(eim, 'eim');

        const pcu = entries.find((entry) => entry?.type === 'inverters');
        return pcu ? this.toReading(pcu, 'inverters') : null;
    }

    /**
     * Home consumption is the "total-consumption" CT when the gateway has one.
     * A gateway wired for net metering only reports "net-consumption" (what
     * crosses the meter), so reconstruct the house load as production + net.
     */
    parseConsumption(stats, production) {
        const entries = Array.isArray(stats?.consumption) ? stats.consumption : [];

        const total = entries.find((entry) => entry?.measurementType === 'total-consumption');
        if (total) {
            this.consumptionMeasured = true;
            return this.toReading(total, 'total-consumption');
        }

        // Reconstructed rather than measured. Grid energy cannot be derived from
        // it: consumption - production collapses back to the gateway's own
        // signed net register, whose behaviour on export this plugin has never
        // been able to verify. readGrid() integrates power instead.
        this.consumptionMeasured = false;

        const net = entries.find((entry) => entry?.measurementType === 'net-consumption');
        if (!net || !production) return null;

        const netReading = this.toReading(net, 'net-consumption');
        return {
            power: this.addOrNull(production.power, netReading.power),
            energyLifetime: this.addOrNull(production.energyLifetime, netReading.energyLifetime),
            energySource: 'derived',
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
                energySource: 'api/v1',
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
    toReading(entry, source = 'unknown') {
        const lines = Array.isArray(entry.lines) ? entry.lines : [];
        const lineTotal = lines.reduce((sum, line) => sum + (num(line?.whLifetime) ?? 0), 0);
        const whLifetime = num(entry.whLifetime);
        const fromLines = whLifetime === null && lines.length > 0;
        const energyLifetime = whLifetime ?? (fromLines ? lineTotal : null);

        return {
            power: num(entry.wNow),
            energyLifetime,
            // Which register this lifetime came from. The entry's own total and
            // the sum of its lines are different counters, so switching between
            // them steps the reading just as switching entries does.
            energySource: energyLifetime === null ? null : `${source}${fromLines ? '/lines' : ''}`,
            voltage: num(entry.rmsVoltage),
            current: num(entry.rmsCurrent)
        };
    }

    addOrNull(a, b) {
        return isNumber(a) && isNumber(b) ? a + b : null;
    }

    subtractOrNull(a, b) {
        return isNumber(a) && isNumber(b) ? a - b : null;
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
