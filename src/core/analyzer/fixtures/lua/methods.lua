local M = {}

function M.build()
  return 1
end

function M:render()
  return self
end

function M.run()
  M.build()
  M:render()
end

return M
