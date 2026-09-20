export const ACQUIRE_PAGE_CACHE_LEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if raw then
  local active = cjson.decode(raw)
  if active.expiresAt > now then return nil end
end
local fence = redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
local fields = cjson.decode(ARGV[3])
local values = {}
for index, field in ipairs(fields) do
  values[index] = tonumber(redis.call('HGET', KEYS[3], field) or '0')
end
redis.call('PEXPIRE', KEYS[3], ARGV[4])
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
local previous_raw = redis.call('GET', KEYS[2])
if previous_raw then
  local previous = cjson.decode(previous_raw)
  if previous.indexMember then
    redis.call('ZREM', previous.pathsKey, previous.indexMember)
    for _, tag_key in ipairs(previous.tagKeys) do
      redis.call('ZREM', tag_key, previous.indexMember)
    end
  end
end
local expires_at = now + tonumber(ARGV[5])
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
redis.call('ZADD', KEYS[4], expires_at, ARGV[4])
redis.call('PEXPIRE', KEYS[4], ARGV[6])
for index = 5, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[index], '-inf', now)
  redis.call('ZADD', KEYS[index], expires_at, ARGV[4])
  redis.call('PEXPIRE', KEYS[index], ARGV[6])
end
redis.call('PEXPIRE', KEYS[3], ARGV[6])
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
    if value.indexMember then
      redis.call('ZREM', value.pathsKey, value.indexMember)
      for _, tag_key in ipairs(value.tagKeys) do
        redis.call('ZREM', tag_key, value.indexMember)
      end
    end
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
redis.call('PEXPIRE', KEYS[1], ARGV[4])
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local members = redis.call('ZRANGE', KEYS[2], 0, -1)
local seen = {}
local affected = {}
for _, member in ipairs(members) do
  local index = cjson.decode(member)
  local matches = index.path == ARGV[2]
  if ARGV[3] == 'layout' and not matches then
    matches = ARGV[2] == '/' or string.sub(index.path, 1, string.len(ARGV[2]) + 1) == ARGV[2] .. '/'
  end
  if matches then
    redis.call('DEL', index.entryKey)
    redis.call('ZREM', index.pathsKey, member)
    for _, tag_key in ipairs(index.tagKeys) do
      redis.call('ZREM', tag_key, member)
    end
    if not seen[index.path] then
      seen[index.path] = true
      table.insert(affected, index.path)
    end
  end
end
return affected
`;

export const INVALIDATE_PAGE_CACHE_TAGS_SCRIPT = `
local tags = cjson.decode(ARGV[1])
for _, tag in ipairs(tags) do
  redis.call('HINCRBY', KEYS[1], 'tag:' .. tag, 1)
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
local seen_members = {}
local seen_paths = {}
local affected = {}
for key_index = 3, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[key_index], '-inf', now)
  local members = redis.call('ZRANGE', KEYS[key_index], 0, -1)
  for _, member in ipairs(members) do
    if not seen_members[member] then
      seen_members[member] = true
      local index = cjson.decode(member)
      redis.call('DEL', index.entryKey)
      redis.call('ZREM', index.pathsKey, member)
      for _, tag_key in ipairs(index.tagKeys) do
        redis.call('ZREM', tag_key, member)
      end
      if not seen_paths[index.path] then
        seen_paths[index.path] = true
        table.insert(affected, index.path)
      end
    end
  end
end
return affected
`;
