-- Atomic purchase: inventory check + user limit check + deduct
-- Replaces the distributed lock + separate DB count + old deduct-inventory.lua
--
-- KEYS[1] = inventory:{saleId}
-- KEYS[2] = sold:{saleId}
-- KEYS[3] = user_purchases:{userId}:{saleId}
-- ARGV[1] = quantity
-- ARGV[2] = maxPerUser
-- ARGV[3] = TTL in seconds for user_purchases key (set to sale remaining time)
--
-- Return codes:
--   -2  = inventory key not initialised (500)
--   -1  = sold out (409)
--   -3  = user limit exceeded (400)
--   N≥0 = remaining stock after deduction (success)

local stock_val = redis.call('GET', KEYS[1])

if not stock_val then
  return -2
end

local stock = tonumber(stock_val)
local qty   = tonumber(ARGV[1])

if stock < qty then
  return -1
end

local bought_val = redis.call('GET', KEYS[3])
local bought = 0
if bought_val then
  bought = tonumber(bought_val)
end

if bought + qty > tonumber(ARGV[2]) then
  return -3
end

redis.call('DECRBY', KEYS[1], qty)
redis.call('INCRBY', KEYS[2], qty)
redis.call('INCRBY', KEYS[3], qty)
redis.call('EXPIRE', KEYS[3], ARGV[3])

return tonumber(redis.call('GET', KEYS[1]))
