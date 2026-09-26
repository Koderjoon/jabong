// 백업 파일 암호화. 브라우저와 Node(GitHub Actions의 자동 백업) 양쪽에서 같은 코드를 쓴다.
// jabong-backup 저장소의 backupcrypt.mjs는 이 파일의 복사본이다. 형식을 바꾸면 둘 다 고친다.
//
// 형식: { format, v, createdAt, iter, salt, iv, data }  (salt·iv·data는 base64)
// 암호 → PBKDF2-SHA256(iter회) → AES-256-GCM 키

const ITER = 200000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function keyFrom(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptBackup(dump, password) {
  if (!password || password.length < 4) throw new Error('백업 암호는 4자 이상이어야 해요');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, ITER);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(dump)));
  return { format: 'jabong-backup-encrypted', v: 1, createdAt: dump.createdAt, iter: ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

export async function decryptBackup(file, password) {
  if (file?.format !== 'jabong-backup-encrypted') throw new Error('자봉 장부 백업 파일이 아니에요');
  const key = await keyFrom(password, fromB64(file.salt), file.iter);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.data));
  } catch {
    throw new Error('백업 암호가 맞지 않아요');
  }
  return JSON.parse(dec.decode(plain));
}
