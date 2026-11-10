"use strict";
// Вычисление Argon2id в фоновом потоке, чтобы интерфейс не зависал.
importScripts("argon2.js");
self.onmessage = e => {
  const { id, password, salt, t, m, p } = e.data;
  try {
    const tag = self.Argon2.argon2id({ password, salt, t, m, p, tagLength: 32 });
    self.postMessage({ id, tag }, [tag.buffer]);
  } catch (err) { self.postMessage({ id, error: String(err) }); }
  password.fill(0);
};
