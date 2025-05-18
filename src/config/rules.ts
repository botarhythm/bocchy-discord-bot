// bocchy_core_rules: URLクロールAPI制限値

export const CRAWL_MAX_DEPTH = {
  user: 2,
  admin: 4,
};
export const CRAWL_MAX_LINKS_PER_PAGE = {
  user: 10,
  admin: 30,
};
export const CRAWL_API_MAX_CALLS_PER_REQUEST = {
  user: 10,
  admin: 30,
};
export const CRAWL_API_MAX_CALLS_PER_USER_PER_DAY = {
  user: 5,
  admin: 50,
};
export const CRAWL_CACHE_TTL_MINUTES = 10; 