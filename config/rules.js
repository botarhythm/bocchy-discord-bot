// bocchy_core_rules: URLクロールAPI制限値

module.exports = {
  // --- クロールAPI制限 ---
  CRAWL_MAX_DEPTH: {
    user: 2,
    admin: 4,
  },
  CRAWL_MAX_LINKS_PER_PAGE: {
    user: 10,
    admin: 30,
  },
  CRAWL_API_MAX_CALLS_PER_REQUEST: {
    user: 10,
    admin: 30,
  },
  CRAWL_API_MAX_CALLS_PER_USER_PER_DAY: {
    user: 5,
    admin: 50,
  },
  CRAWL_CACHE_TTL_MINUTES: 10,
}; 