--[[
 redis.eval('zhvalues', key, min, max, [limit, offset, count])

 Make a range query by lex on an ordered map and return the values
 Note that the last returned value is the key of the last value. Used for the next iteration.

 `redis-cli EVAL "$(cat zhvalues-lk.lua)" 1 _redisdown_test_db_:10 - +`
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
values[#values+1] = keys[#keys]
return values
