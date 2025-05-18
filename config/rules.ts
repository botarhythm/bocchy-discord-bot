// bocchy_core_rules: URLクロールAPI制限値
const CRAWL_MAX_DEPTH = {
    user: 2,
    admin: 4,
};
const CRAWL_MAX_LINKS_PER_PAGE = {
    user: 10,
    admin: 30,
};
const CRAWL_API_MAX_CALLS_PER_REQUEST = {
    user: 10,
    admin: 30,
};
const CRAWL_API_MAX_CALLS_PER_USER_PER_DAY = {
    user: 5,
    admin: 50,
};
const CRAWL_CACHE_TTL_MINUTES = 10;
const BASE = {
    SHORT_TERM_MEMORY_LENGTH: 8,
};

export {
  CRAWL_MAX_DEPTH,
  CRAWL_MAX_LINKS_PER_PAGE,
  CRAWL_API_MAX_CALLS_PER_REQUEST,
  CRAWL_API_MAX_CALLS_PER_USER_PER_DAY,
  CRAWL_CACHE_TTL_MINUTES,
  BASE
};
