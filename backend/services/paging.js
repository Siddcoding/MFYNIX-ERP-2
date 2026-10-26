/**
 * Shared paging helper.
 *
 * Before this, every list route ended in a hardcoded `LIMIT 200`, which meant
 * a branch simply stopped being able to see its older invoices after a few
 * months - and did so silently, which is the worst way for a limit to behave.
 * Routes now return { rows, page, pageSize, total, totalPages } so the UI can
 * page through everything and always show how much there is.
 */
function readPaging(query, { defaultPageSize = 25, maxPageSize = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pagedResult(rows, total, { page, pageSize }) {
  return { rows, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

module.exports = { readPaging, pagedResult };
