export const ACQUIRE_PAGE_CACHE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if raw then
  local active = cjson.decode(raw)
  if active.expiresAt > now then return nil end
end
local fence = redis.call('INCR', KEYS[2])
local fields = cjson.decode(ARGV[3])
local values = {}
for index, field in ipairs(fields) do
  values[index] = tonumber(redis.call('HGET', KEYS[3], field) or '0')
end
local lease = {
  expiresAt = now + tonumber(ARGV[2]),
  fence = fence,
  fields = fields,
  id = ARGV[1],
  values = values
}
redis.call('SET', KEYS[1], cjson.encode(lease), 'PX', ARGV[2])
return cjson.encode(lease)
`;

export const COMMIT_PAGE_CACHE_ENTRY_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'superseded' end
local lease = cjson.decode(raw)
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if lease.id ~= ARGV[1] or lease.fence ~= tonumber(ARGV[2]) or lease.expiresAt <= now then
  return 'superseded'
end
for index, field in ipairs(lease.fields) do
  local current = tonumber(redis.call('HGET', KEYS[3], field) or '0')
  if current ~= lease.values[index] then
    redis.call('DEL', KEYS[1])
    return 'superseded'
  end
end
redis.call('SET', KEYS[2], ARGV[3])
redis.call('ZADD', KEYS[4], 0, ARGV[4])
for index = 5, #KEYS do
  redis.call('SADD', KEYS[index], ARGV[4])
end
redis.call('DEL', KEYS[1])
return 'stored'
`;

export const READ_PAGE_CACHE_ENTRY_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
local value = cjson.decode(raw)
for index, field in ipairs(value.fields) do
  local current = tonumber(redis.call('HGET', KEYS[2], field) or '0')
  if current ~= value.values[index] then
    redis.call('DEL', KEYS[1])
    return nil
  end
end
return raw
`;

export const RELEASE_PAGE_CACHE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local lease = cjson.decode(raw)
if lease.id == ARGV[1] and lease.fence == tonumber(ARGV[2]) then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const INVALIDATE_PAGE_CACHE_PATH_SCRIPT = `
redis.call('HINCRBY', KEYS[1], ARGV[1], 1)
local paths = redis.call('ZRANGE', KEYS[2], 0, -1)
local affected = {}
for _, path in ipairs(paths) do
  local matches = path == ARGV[2]
  if ARGV[3] == 'layout' and not matches then
    matches = ARGV[2] == '/' or string.sub(path, 1, string.len(ARGV[2]) + 1) == ARGV[2] .. '/'
  end
  if matches then table.insert(affected, path) end
end
return affected
`;

export const INVALIDATE_PAGE_CACHE_TAGS_SCRIPT = `
local tags = cjson.decode(ARGV[1])
for _, tag in ipairs(tags) do
  redis.call('HINCRBY', KEYS[1], 'tag:' .. tag, 1)
end
local seen = {}
local affected = {}
for index = 2, #KEYS do
  local paths = redis.call('SMEMBERS', KEYS[index])
  for _, path in ipairs(paths) do
    if not seen[path] then
      seen[path] = true
      table.insert(affected, path)
    end
  end
end
return affected
`;
