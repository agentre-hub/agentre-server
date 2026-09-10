/**
 * WebAuthn 的 JSON 线格式 ⇄ 浏览器 API 之间的编解码。
 *
 * 服务端两个 begin 端点回的都是 go-webauthn 的选项原文：challenge、user.id、
 * excludeCredentials[].id、allowCredentials[].id 是 protocol.URLEncodedBase64，
 * 也就是**不带 `=` 补位、用 `-` `_` 字母表**的 base64url 字符串
 * （encoding/base64.RawURLEncoding）。而 navigator.credentials.create/get 的 IDL
 * 把这些字段声明成 BufferSource——喂字符串进去，浏览器抛 TypeError。回程反过来：
 * 认证器给的是 ArrayBuffer，两个 finish 端点要的还是同一种 base64url 字符串，
 * 而 JSON.stringify 会把 ArrayBuffer 悄悄变成 `{}`。
 *
 * 只按决策 17 的 `window.PublicKeyCredential` 探测支持与否，因此不能假设
 * `PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON`
 * / `credential.toJSON()` 这类更新的便利方法一定存在，这里手写转换。
 *
 * 注册与登录两条路径共用这一份：两边各抄一份的结果已经付过一次代价——注册那边写对了、
 * 登录那边直接透传，真实浏览器上必失败，而桩住 navigator.credentials 的单测照样绿。
 */

export function base64UrlToBuffer(s: string): ArrayBuffer {
  const base64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 选项里的凭证描述符，`id` 还是 base64url 字符串的那一版。 */
export interface RawCredentialDescriptor {
  type: string;
  id: string;
  transports?: string[];
}

/** `POST /v1/passkeys/register/begin` 回应里的 publicKey。 */
export interface RawCreationOptions {
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: RawCredentialDescriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
}

/**
 * `POST /v1/passkeys/login/begin` 回应里的 publicKey。
 *
 * `allowCredentials` 声明成可选不是保守：可发现凭证登录（决策 10）下服务端
 * `BeginDiscoverableLogin` 根本不发这个字段，由浏览器自己弹选择器。
 */
export interface RawRequestOptions {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: RawCredentialDescriptor[];
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
}

/** 描述符的 `type` 在规范里只有 "public-key" 一个取值，写死比透传更贴类型。 */
function decodeDescriptor(
  c: RawCredentialDescriptor,
): PublicKeyCredentialDescriptor {
  return {
    type: "public-key",
    id: base64UrlToBuffer(c.id),
    transports: c.transports as AuthenticatorTransport[] | undefined,
  };
}

export function decodeCreationOptions(
  raw: RawCreationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    ...raw,
    challenge: base64UrlToBuffer(raw.challenge),
    user: { ...raw.user, id: base64UrlToBuffer(raw.user.id) },
    excludeCredentials: raw.excludeCredentials?.map(decodeDescriptor),
  };
}

export function decodeRequestOptions(
  raw: RawRequestOptions,
): PublicKeyCredentialRequestOptions {
  return {
    ...raw,
    challenge: base64UrlToBuffer(raw.challenge),
    allowCredentials: raw.allowCredentials?.map(decodeDescriptor),
  };
}

export function encodeCreationResponse(cred: PublicKeyCredential): unknown {
  const response = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      attestationObject: bufferToBase64Url(response.attestationObject),
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      transports:
        typeof response.getTransports === "function"
          ? response.getTransports()
          : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

export function encodeAssertionResponse(cred: PublicKeyCredential): unknown {
  const response = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bufferToBase64Url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      // 可发现凭证登录靠 userHandle 找账号（go-webauthn 的 ValidatePasskeyLogin
      // 拿它跟 WebAuthnID() 对），为空时整个字段不发：后端那侧是 omitempty，
      // 发一个 null 只会多走一趟 UnmarshalJSON 的 null 分支。
      userHandle: response.userHandle
        ? bufferToBase64Url(response.userHandle)
        : undefined,
    },
    // authenticatorAttachment 刻意不带：后端把它收成 string，而浏览器在拿不准
    // 的时候给的是 null，那会让整个请求体在 json.Unmarshal 就失败。
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}
