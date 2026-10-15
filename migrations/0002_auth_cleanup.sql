-- Keep opportunistic bounded cleanup inexpensive as auth records grow.
CREATE INDEX auth_codes_expiry ON auth_codes(expires_at);
CREATE INDEX auth_dispatch_day ON auth_dispatch(day);
