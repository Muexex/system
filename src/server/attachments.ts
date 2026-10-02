import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { db } from "./db";
import { domain } from "./domain";
import { AuthUser } from "./auth";
import { HttpError, rateLimit } from "./security";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Map([
  ["image/png", "png"], ["image/jpeg", "jpeg"], ["image/webp", "webp"],
]);

function uploadDirectory() {
  return path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), "data", "uploads"));
}

async function boundedFormData(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new HttpError(415, "请以文件上传形式提交图片。");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "未收到图片。");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES + 65_536) {
        await reader.cancel();
        throw new HttpError(413, "图片最大为 5MB。", "IMAGE_TOO_LARGE");
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return await new Response(buffer, { headers: { "content-type": contentType } }).formData();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "无法解析上传图片，请重新选择文件。");
  }
}

function sniffFormat(buffer: Buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpeg";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

export async function uploadAttachment(request: Request, user: AuthUser) {
  if (user.role !== "ASKER") throw new HttpError(403, "仅提问者可以上传题目图片。", "FORBIDDEN");
  await rateLimit(`upload:${user.id}`, 20);
  const form = await boundedFormData(request);
  const files = form.getAll("file");
  const totalFileCount = Array.from(form.values()).filter((value) => value instanceof File).length;
  if (files.length !== 1 || totalFileCount !== 1 || !(files[0] instanceof File)) {
    throw new HttpError(400, "请选择一张题目图片。");
  }
  const file = files[0];
  const format = ALLOWED.get(file.type.toLowerCase());
  if (!format) throw new HttpError(400, "仅允许 PNG、JPEG 或 WebP 图片。", "INVALID_IMAGE");
  if (!file.size || file.size > MAX_BYTES) throw new HttpError(413, "图片需大于 0 字节，且最大为 5MB。");
  const input = Buffer.from(await file.arrayBuffer());
  if (sniffFormat(input) !== format) throw new HttpError(400, "图片内容与文件类型不一致。", "INVALID_IMAGE");
  let safeImage: Buffer;
  try {
    const image = sharp(input, { failOn: "error", limitInputPixels: 20_000_000, animated: false });
    const metadata = await image.metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
      throw new Error("unsupported image");
    }
    // Real decoding/re-encoding discards filenames, scripts, metadata and trailing payloads.
    safeImage = await image.rotate().resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90 }).toBuffer();
  } catch {
    throw new HttpError(400, "图片损坏、像素过大或包含不支持的多帧内容，请换一张静态图片。", "INVALID_IMAGE");
  }
  if (safeImage.byteLength > MAX_BYTES) throw new HttpError(413, "处理后的图片过大，请缩小图片后重试。");
  const id = randomUUID();
  const storageKey = `${randomUUID()}.webp`;
  const directory = uploadDirectory();
  await mkdir(directory, { recursive: true });
  const filename = path.join(/* turbopackIgnore: true */ directory, storageKey);
  await writeFile(filename, safeImage, { flag: "wx", mode: 0o600 });
  try {
    await db.attachment.create({ data: { id, uploaderId: user.id, mime: "image/webp", bytes: safeImage.byteLength, storageKey } });
  } catch (error) {
    await unlink(filename).catch(() => undefined);
    throw error;
  }
  return { attachmentId: id };
}

export async function downloadAttachment(user: AuthUser, id: string) {
  const attachment = await domain.authorizeAttachment(user.id, id);
  // Defense in depth: even database metadata cannot escape the controlled directory.
  if (!/^[a-f0-9-]+\.webp$/.test(attachment.storageKey)) {
    throw new HttpError(404, "图片暂不可用。", "IMAGE_NOT_FOUND");
  }
  let image: Buffer;
  try { image = await readFile(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ uploadDirectory(), attachment.storageKey)); }
  catch { throw new HttpError(404, "图片文件不存在。", "IMAGE_NOT_FOUND"); }
  return new Response(new Uint8Array(image), {
    headers: {
      "Content-Type": attachment.mime,
      "Content-Length": String(image.byteLength),
      "Content-Disposition": "inline; filename=question.webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
