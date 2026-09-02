-- KEYS[1] = lock:{resource}
-- ARGV[1] = expected lock value (UUID set at acquire time)

if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
