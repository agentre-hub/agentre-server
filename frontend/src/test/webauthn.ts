/**
 * 通行密钥用例共用的测试装置。
 *
 * 存在的理由是一次真实的失败：注册那条路的编解码写对了、登录那条路直接把服务端
 * 的选项原文透传给了 `navigator.credentials.get()`，真实浏览器必抛 TypeError，
 * 而单测里的桩子是 `vi.fn().mockResolvedValue(cred)` ——它**根本不看参数**，
 * 于是那个必然失败的调用在用例里一路绿灯，直到 e2e 才暴露。
 *
 * 所以这里的假认证器按浏览器的规矩挑参数：IDL 把 challenge / user.id /
 * allowCredentials[].id / excludeCredentials[].id 都声明成 BufferSource，
 * 喂字符串进去就是 TypeError。桩子必须照做，否则它证明不了任何事。
 */

/**
 * 假认证器**看到**的入参形状。
 *
 * 刻意不用 DOM 的 `PublicKeyCredential*Options`：那套类型把这些字段声明成
 * `BufferSource | undefined`，用例要挑的刺（「这里现在还是不是 ArrayBuffer」、
 * 「allowCredentials 第 0 条的 id 是什么字节」）在它上面写不出来。这里声明的是
 * 「解码之后应该长成的样子」，运行期由下面的校验真正把关。
 */
export interface ObservedDescriptor {
  type: string;
  id: ArrayBuffer;
  transports?: string[];
}

export interface ObservedRequestOptions {
  publicKey: {
    challenge: ArrayBuffer;
    rpId?: string;
    userVerification?: string;
    allowCredentials: ObservedDescriptor[];
  };
}

export interface ObservedCreationOptions {
  publicKey: {
    challenge: ArrayBuffer;
    rp: { id?: string; name: string };
    user: { id: ArrayBuffer; name: string; displayName: string };
    pubKeyCredParams: Array<{ type: string; alg: number }>;
    authenticatorSelection?: Record<string, unknown>;
    excludeCredentials: ObservedDescriptor[];
  };
}

/** 测试自用的 base64url → ArrayBuffer，独立于被测代码，只为构造假认证器回应。 */
export function b64urlToBuffer(s: string): ArrayBuffer {
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function requireBuffer(value: unknown, what: string): void {
  // 浏览器认 BufferSource，也就是 ArrayBuffer 或任意 TypedArray/DataView。
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return;
  throw new TypeError(
    `${what} must be a BufferSource, got ${typeof value === "string" ? "string" : typeof value}`,
  );
}

function requireDescriptors(list: unknown, what: string): void {
  if (list === undefined) return;
  if (!Array.isArray(list)) throw new TypeError(`${what} must be a sequence`);
  for (const d of list as Array<{ id?: unknown; type?: unknown }>) {
    requireBuffer(d.id, `${what}[].id`);
    if (d.type !== "public-key") {
      throw new TypeError(`${what}[].type must be "public-key"`);
    }
  }
}

/**
 * 校验 `navigator.credentials.get({ publicKey })` 的入参形状，不合规就像浏览器
 * 那样抛 TypeError。用例只要在断言里没看见这个错误，就说明去程编码确实做了。
 */
export function assertValidRequestOptions(arg: unknown): void {
  const options = (arg as { publicKey?: Record<string, unknown> } | undefined)
    ?.publicKey;
  if (!options) throw new TypeError("credentials.get needs a publicKey member");
  requireBuffer(options.challenge, "publicKey.challenge");
  requireDescriptors(options.allowCredentials, "publicKey.allowCredentials");
}

/** 同上，注册那一侧：多了 user.id 与 excludeCredentials。 */
export function assertValidCreationOptions(arg: unknown): void {
  const options = (arg as { publicKey?: Record<string, unknown> } | undefined)
    ?.publicKey;
  if (!options)
    throw new TypeError("credentials.create needs a publicKey member");
  requireBuffer(options.challenge, "publicKey.challenge");
  const user = options.user as { id?: unknown } | undefined;
  if (!user) throw new TypeError("publicKey.user is required");
  requireBuffer(user.id, "publicKey.user.id");
  requireDescriptors(
    options.excludeCredentials,
    "publicKey.excludeCredentials",
  );
}

/**
 * 造一个「先按浏览器的规矩挑参数、再给出结果」的 credentials.get 假实现。
 *
 * result 是个函数时按它决定这次的结局（用来模拟用户取消：抛 NotAllowedError），
 * 否则直接兑现成那个凭证。无论哪种结局，参数校验都先跑——取消这条路上的去程
 * 编码同样要被验到。
 */
export function fakeCredentialsGet(
  result: unknown | (() => unknown),
): (arg: ObservedRequestOptions) => Promise<unknown> {
  return (arg: ObservedRequestOptions) => {
    assertValidRequestOptions(arg);
    return Promise.resolve(
      typeof result === "function" ? (result as () => unknown)() : result,
    );
  };
}
