declare const CRAWL_MAX_DEPTH: {
    user: number;
    admin: number;
};
declare const CRAWL_MAX_LINKS_PER_PAGE: {
    user: number;
    admin: number;
};
declare const CRAWL_API_MAX_CALLS_PER_REQUEST: {
    user: number;
    admin: number;
};
declare const CRAWL_API_MAX_CALLS_PER_USER_PER_DAY: {
    user: number;
    admin: number;
};
declare const CRAWL_CACHE_TTL_MINUTES = 10;
declare const BASE: {
    SHORT_TERM_MEMORY_LENGTH: number;
};
export { CRAWL_MAX_DEPTH, CRAWL_MAX_LINKS_PER_PAGE, CRAWL_API_MAX_CALLS_PER_REQUEST, CRAWL_API_MAX_CALLS_PER_USER_PER_DAY, CRAWL_CACHE_TTL_MINUTES, BASE };
