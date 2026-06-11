// 端到端加密聊天工具：ECDH(P-256) 协商共享密钥 → HKDF → AES-256-GCM
// 私钥仅保存在浏览器 localStorage（按用户隔离），服务器只保存公钥与密文。
// 注意：换浏览器/清缓存后旧私聊消息将无法解密（局域网场景的取舍，见 README）。

const b64 = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
  dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
};

// 取/建本浏览器的 ECDH 密钥对（JWK 存 localStorage）
export async function ensureKeyPair(userId) {
  const storeKey = `lvs_chat_key_${userId}`;
  const cached = localStorage.getItem(storeKey);
  if (cached) return JSON.parse(cached);
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const rec = {
    priv: await crypto.subtle.exportKey('jwk', pair.privateKey),
    pub: await crypto.subtle.exportKey('jwk', pair.publicKey)
  };
  localStorage.setItem(storeKey, JSON.stringify(rec));
  return rec;
}

// 我的私钥 + 对方公钥 → AES-GCM 会话密钥（双方推导结果一致）
export async function deriveSharedKey(myPrivJwk, peerPubJwk) {
  const priv = await crypto.subtle.importKey('jwk', myPrivJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('jwk', peerPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('lvs-chat-v1') },
    hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return { content: b64.enc(ct), iv: b64.enc(iv) };
}

export async function decryptText(key, content, iv) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(iv) }, key, b64.dec(content));
  return new TextDecoder().decode(pt);
}
