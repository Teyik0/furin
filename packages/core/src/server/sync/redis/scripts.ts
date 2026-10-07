export const BEGIN_MUTATION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if raw then
  local value = cjson.decode(raw)
  if value.fingerprint ~= ARGV[1] then
    return {'conflict', 'payload-mismatch'}
  end
  if value.state == 'succeeded' then
    return {'replay', raw}
  end
  if value.leaseUntil > now then
    return {'conflict', 'in-progress'}
  end
end
local value = {
  fingerprint = ARGV[1],
  id = ARGV[2],
  leaseUntil = now + tonumber(ARGV[3]),
  state = 'in-progress'
}
redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ARGV[4])
return {'execute', ARGV[2]}
`;

export const RENEW_MUTATION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lost' end
local value = cjson.decode(raw)
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if value.state ~= 'in-progress' or value.id ~= ARGV[1] or value.leaseUntil <= now then
  return 'lost'
end
value.leaseUntil = now + tonumber(ARGV[2])
redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ARGV[3])
return 'renewed'
`;

export const COMPLETE_MUTATION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'lost'} end
local value = cjson.decode(raw)
local now_parts = redis.call('TIME')
local now = tonumber(now_parts[1]) * 1000 + math.floor(tonumber(now_parts[2]) / 1000)
if value.state ~= 'in-progress' or value.id ~= ARGV[1] or value.leaseUntil <= now then
  return {'lost'}
end
value.state = 'succeeded'
value.response = ARGV[2]
value.leaseUntil = nil
local cursor = ''
if ARGV[3] ~= '[]' then
  local length = redis.call('XLEN', KEYS[2])
  if length >= tonumber(ARGV[5]) then
    local oldest = redis.call('XRANGE', KEYS[2], '-', '+', 'COUNT', 1)
    if oldest[1] then redis.call('SET', KEYS[3], oldest[1][1]) end
  end
  cursor = redis.call('XADD', KEYS[2], 'MAXLEN', '=', ARGV[5], '*', 'data', ARGV[3], 'principal', ARGV[6])
end
redis.call('SET', KEYS[1], cjson.encode(value), 'PX', ARGV[4])
return {'committed', cursor}
`;

export const ABORT_MUTATION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local value = cjson.decode(raw)
if value.state == 'in-progress' and value.id == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
