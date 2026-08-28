/**
 * Deliberately distinct from `homebridge-enphase-envoy` / `enphaseEnvoy`, so
 * this plugin installs and runs alongside the original rather than replacing
 * it. Both may talk to the same gateway; every call made here is read-only.
 */
export const PluginName = 'homebridge-enphase-envoy-matter';
export const PlatformName = 'enphaseEnvoyMatter';
export const DisplayName = 'Enphase Envoy Matter';

/** Storage subdirectory for the token cache, kept separate for the same reason. */
export const StorageDir = 'enphaseEnvoyMatter';

/** Local accounts used for HTTP Digest auth on firmware < v7. */
export const Authorization = {
    EnvoyUser: 'envoy',
    Realm: 'enphaseenergy.com'
};

/** Enlighten cloud endpoints used to mint a JWT for firmware v7+. */
export const EnphaseUrls = {
    BaseUrl: 'https://enlighten.enphaseenergy.com',
    Login: '/login/login.json',
    EntrezAuthToken: '/entrez-auth-token'
};

/**
 * The only Envoy endpoints this plugin talks to.
 *
 * SystemReadingStats is the workhorse: on a metered gateway it returns both
 * production and consumption in a single call. Production is the fallback for
 * gateways without CTs installed, and reports production only.
 */
export const ApiUrls = {
    GetInfo: '/info.xml',
    CheckJwt: '/auth/check_jwt',
    SystemReadingStats: '/production.json?details=1',
    Production: '/api/v1/production'
};

/** Part number -> marketing model name, used for the Matter accessory model. */
export const PartNumbers = {
    '800-00551-r03': 'X-IQ-AM1-120-B-M',
    '800-00553-r03': 'X-IQ-AM1-240-B',
    '800-00557-r03': 'X-IQ-AM1-240-BM',
    '800-00554-r04': 'X-IQ-AM1-240-2',
    '800-00554-r05': 'X-IQ-AM1-240-2-M',
    '800-00555-r03': 'X-IQ-AM1-240-3',
    '800-00655-r09': 'X-IQ-AM1-240-3-ES',
    '800-00556-r03': 'X-IQ-AM1-240-3C',
    '800-00554-r07': 'X-IQ-AM1-240-3C-ES',
    '880-00122-r02': 'ENV-S-AB-120-A',
    '880-00210-r02': 'ENV-S-AM1-120',
    '800-00552-r01': 'ENV-S-WM-230',
    '800-00553-r01': 'ENV-S-WB-230',
    '800-00553-r02': 'ENV-S-WB-230-F',
    '800-00554-r03': 'ENV-S-WM-230',
    '800-00654-r06': 'ENV-S-WM-230',
    '800-00654-r08': 'ENV-S-WM-230',
    '800-00664-r05': 'ENV-S-WM-230',
    '880-00208-r02': 'ENV-IQ-AM1-240',
    '880-00208-r03': 'ENV-IQ-AM1-240',
    '880-00231-r02': 'ENV-IQ-AM1-240',
    '880-00209-r03': 'ENV-IQ-AM3-3P',
    '880-00557-r02': 'ENV-IQ-AM3-3P',
    '800-02403-r08': 'IQ Combiner C6'
};

/** Identifies the Matter sensors this plugin publishes. */
export const MeasurementKind = {
    Production: 'production',
    Consumption: 'consumption',
    Grid: 'grid'
};
