--[[
 redis.eval('zhrevvalues', key, max, min, [limit, offset, count])

 Make a reverse range by lex on an order map and return the values
 Note that the last returned value is the key of the last value. Used for the next iteration.

 `redis-cli EVAL "$(cat zhrevvalues.lua)" 1 _redisdown_test_db_:10 - +`
]]
local keys = redis.call('zrevrangebylex', KEYS[1]..':z', unpack(ARGV))
if #keys == 0 then
  return keys
end
local prefixkeys = {}
for i,v in ipairs(keys) do
  prefixkeys[i] = KEYS[1]..'$'..v
end
local values = redis.call('mget', unpack(prefixkeys))
values[#values+1] = keys[#keys]
return values
