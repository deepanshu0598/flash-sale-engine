-- KEYS[1] = inventory:{saleId}
-- KEYS[2] = sold:{saleId}
-- ARGV[1] = quantity

local stock = tonumber(redis.call('GET', KEYS[1]))

if stock == nil then
  return -2
end

if stock < tonumber(ARGV[1]) then
  return -1
end

redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('INCRBY', KEYS[2], ARGV[1])

return tonumber(redis.call('GET', KEYS[1]))
