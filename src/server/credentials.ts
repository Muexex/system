import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { HttpError } from "./security";

const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 64;
const PASSWORD_VERSION = "scrypt$v1$32768$8$1";
// Unknown usernames still perform the same expensive password derivation.
const DUMMY_HASH = `${PASSWORD_VERSION}$${"0".repeat(32)}$${"0".repeat(128)}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

export function validatePassword(value: unknown) {
  if (typeof value !== "string" || Array.from(value).length < 10 || Array.from(value).length > 128
    || value.includes("\u0000") || Buffer.byteLength(value, "utf8") > 512) {
    throw new HttpError(400, "密码须为 10—128 个字符，不包含空字符。", "INVALID_PASSWORD");
  }
  return value;
}

export function normalizeUsername(value: unknown) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{3,32}$/.test(value.trim())) {
    throw new HttpError(400, "账号须为 3—32 位字母、数字、点、下划线或短横线。", "INVALID_USERNAME");
  }
  return value.trim().toLowerCase();
}

export async function hashPassword(password: string) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PASSWORD_VERSION}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string | null | undefined) {
  const actual = encoded || DUMMY_HASH;
  const parts = actual.split("$");
  const valid = parts.length === 7 && parts.slice(0, 5).join("$") === PASSWORD_VERSION
    && /^[a-f0-9]{32}$/.test(parts[5]) && /^[a-f0-9]{128}$/.test(parts[6]);
  const salt = Buffer.from(valid ? parts[5] : "0".repeat(32), "hex");
  const expected = Buffer.from(valid ? parts[6] : "0".repeat(128), "hex");
  const actualKey = await derive(password, salt);
  return timingSafeEqual(actualKey, expected) && valid && Boolean(encoded);
}
