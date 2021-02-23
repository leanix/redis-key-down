--[[
 redis.eval('zhpairs', key, min, max, [limit, offset, count])

 Make a range query by lex on an ordered map and return the pairs.

 `redis-cli EVAL "$(cat zhpairs.lua)" 1 _redisdown_test_db_:10 ZRANGEBYLEX - +`
]]
local keys = redis.call('zrangebylex', KEYS[1]..':z', unpack(ARGV))
if #keys == 0 then
  return keys
end
local prefixkeys = {}
for i,v in ipairs(keys) do
  prefixkeys[i] = KEYS[1]..'$'..v
end
local values = redis.call('mget', unpack(prefixkeys))
local result = {}
for i,v in ipairs(keys) do
  result[i*2-1] = v
  result[i*2] = values[i]
end
return result
