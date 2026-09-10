import { describe, expect, it } from "vitest";

import {
  base64UrlToBuffer,
  bufferToBase64Url,
  decodeCreationOptions,
  decodeRequestOptions,
  encodeAssertionResponse,
  encodeCreationResponse,
} from "@/lib/webauthn";

/**
 * WebAuthn 的 JSON 线格式 ⇄ 浏览器 API 之间那层编解码的用例。
 *
 * 这层是纯函数，没有 DOM、没有网络、没有认证器——真断言在这里最便宜，也只有在
 * 这里才断得出「字节到底对不对」。页面用例只能验「传下去的是不是 ArrayBuffer」，
 * 验不了「这个 ArrayBuffer 里装的是不是那 32 个字节」。
 *
 * 判据取自 go-webauthn 的 protocol.URLEncodedBase64：编码用 base64.RawURLEncoding
 * ——`-` `_` 字母表、**不带** `=` 补位。任何一处按标准 base64 处理都会在真实浏览器
 * 上炸掉，而 jsdom 里的 atob 对两种字母表的差异只在遇到 `-` `_` 时才报错。
 */

/** 十六进制串 → 字节，用来把期望值写得能一眼读出来。 */
function bytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bufferOf(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

describe("base64url ⇄ ArrayBuffer", () => {
  it("解出来的是 ArrayBuffer，不是字符串", () => {
    // WebAuthn 的 IDL 把 challenge 声明成 BufferSource；喂字符串进去浏览器直接抛
    // TypeError，而这正是通行密钥登录那条路径上真实发生过的失败。
    const buf = base64UrlToBuffer("AQID");
    expect(buf instanceof ArrayBuffer).toBe(true);
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("认 base64url 的 '-' '_' 字母表，而不是标准 base64 的 '+' '/'", () => {
    // 0xfb 0xff → 6 位分组 111110 / 111111 / 1111(补0)=111100
    //           → 标准 base64 "+/8"，base64url "-_8"
    expect(new Uint8Array(base64UrlToBuffer("-_8"))).toEqual(bytes("fbff"));
    expect(bufferToBase64Url(bufferOf(0xfb, 0xff))).toBe("-_8");
  });

  it("编码不产生 '='、'+'、'/'", () => {
    // 后端解码走 RawURLEncoding：多一个 '=' 就是一次 CorruptInputError。
    // 三种余数长度都覆盖：1 字节余 2 位、2 字节余 4 位、3 字节整除。
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const s = bufferToBase64Url(
        new Uint8Array(Array.from({ length: n }, (_, i) => 250 + i)).buffer,
      );
      expect(s, `${n} 字节编出来的 ${s}`).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it("解码认不带 '=' 补位的输入", () => {
    // go-webauthn 发出来的就是不带补位的。长度 % 4 == 2 与 == 3 两种都要认。
    expect(base64UrlToBuffer("AQ").byteLength).toBe(1); // 4-2
    expect(base64UrlToBuffer("AQI").byteLength).toBe(2); // 4-3
    expect(base64UrlToBuffer("AQID").byteLength).toBe(3); // 整除
    expect(new Uint8Array(base64UrlToBuffer("AQ"))).toEqual(bytes("01"));
    expect(new Uint8Array(base64UrlToBuffer("AQI"))).toEqual(bytes("0102"));
  });

  it("0..255 每个字节值都能原样往返", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const encoded = bufferToBase64Url(all.buffer);
    expect(new Uint8Array(base64UrlToBuffer(encoded))).toEqual(all);
  });

  it("空缓冲往返成空串", () => {
    expect(bufferToBase64Url(new ArrayBuffer(0))).toBe("");
    expect(base64UrlToBuffer("").byteLength).toBe(0);
  });

  it("认服务端真实发过的那一条 challenge", () => {
    // 取自一次真实 e2e 运行里 POST /v1/passkeys/login/begin 的回应正文：
    // 43 个字符、不带补位、含 '_'，解出来正好是 32 字节的 challenge。
    const real = "31Ibesh_SMisD_nM7sSvnYsFpOP9K3hXVXmNKiXMU2g";
    const buf = base64UrlToBuffer(real);
    expect(buf.byteLength).toBe(32);
    expect(bufferToBase64Url(buf)).toBe(real);
  });
});

describe("注册选项 / 回应的编解码", () => {
  it("decodeCreationOptions 把 challenge、user.id、excludeCredentials[].id 都换成 ArrayBuffer", () => {
    const options = decodeCreationOptions({
      rp: { id: "agentre.example", name: "AgentRe" },
      user: { id: "CQkJCQ", name: "lin.wei@example.com", displayName: "林薇" },
      challenge: "AQIDBAX6-w",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [
        { type: "public-key", id: "BwcHBwcH", transports: ["internal"] },
      ],
    });

    expect(options.challenge instanceof ArrayBuffer).toBe(true);
    expect(new Uint8Array(options.challenge as ArrayBuffer)).toEqual(
      bytes("0102030405fafb"),
    );
    expect(new Uint8Array(options.user.id as ArrayBuffer)).toEqual(
      bytes("09090909"),
    );
    const excluded = options.excludeCredentials?.[0];
    expect(excluded?.id instanceof ArrayBuffer).toBe(true);
    expect(new Uint8Array(excluded?.id as ArrayBuffer)).toEqual(
      bytes("070707070707"),
    );
    expect(excluded?.transports).toEqual(["internal"]);
    // 其余字段原样带过，rp / pubKeyCredParams 不是 buffer，别动它们
    expect(options.rp).toEqual({ id: "agentre.example", name: "AgentRe" });
    expect(options.user.name).toBe("lin.wei@example.com");
  });

  it("encodeCreationResponse 把认证器回应编回 base64url 字符串", () => {
    const encoded = encodeCreationResponse({
      id: "new-cred",
      type: "public-key",
      rawId: bufferOf(7, 7, 7, 7, 7, 7),
      response: {
        attestationObject: bufferOf(0xa1, 0xa2, 0xa3),
        clientDataJSON: bufferOf(0x7b, 0x7d),
        getTransports: () => ["internal"],
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential) as Record<string, unknown>;

    expect(encoded.id).toBe("new-cred");
    expect(encoded.type).toBe("public-key");
    expect(encoded.rawId).toBe("BwcHBwcH");
    const response = encoded.response as Record<string, unknown>;
    expect(response.attestationObject).toBe("oaKj");
    expect(response.clientDataJSON).toBe("e30");
    expect(response.transports).toEqual(["internal"]);
  });

  it("认证器没有 getTransports 时不报错", () => {
    // getTransports 是后来才加进规范的，旧认证器/旧浏览器上可能不存在。
    const encoded = encodeCreationResponse({
      id: "c",
      type: "public-key",
      rawId: bufferOf(1),
      response: {
        attestationObject: bufferOf(2),
        clientDataJSON: bufferOf(3),
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential) as Record<string, unknown>;
    expect((encoded.response as Record<string, unknown>).transports).toBe(
      undefined,
    );
  });
});

describe("登录选项 / 回应的编解码", () => {
  it("decodeRequestOptions 把 challenge 换成 ArrayBuffer 并原样带过其余字段", () => {
    // 这一条正是服务端 BeginLogin 真实发出来的形状：可发现凭证登录（决策 10）
    // 下 allowCredentials 整个字段都不存在。
    const options = decodeRequestOptions({
      challenge: "31Ibesh_SMisD_nM7sSvnYsFpOP9K3hXVXmNKiXMU2g",
      timeout: 300000,
      rpId: "localhost",
      userVerification: "preferred",
    });

    expect(options.challenge instanceof ArrayBuffer).toBe(true);
    expect((options.challenge as ArrayBuffer).byteLength).toBe(32);
    expect(options.timeout).toBe(300000);
    expect(options.rpId).toBe("localhost");
    expect(options.userVerification).toBe("preferred");
    // 字段不在就不要凭空造一个空数组：浏览器把 `allowCredentials: []` 与
    // 「没有这个字段」当同一件事，但少一处凭空构造就少一处会漂的行为。
    expect(options.allowCredentials).toBe(undefined);
  });

  it("decodeRequestOptions 把 allowCredentials[].id 换成 ArrayBuffer", () => {
    const options = decodeRequestOptions({
      challenge: "AQID",
      allowCredentials: [
        { type: "public-key", id: "BwcHBwcH", transports: ["usb", "nfc"] },
        { type: "public-key", id: "-_8" },
      ],
    });

    const [first, second] = options.allowCredentials ?? [];
    expect(first.id instanceof ArrayBuffer).toBe(true);
    expect(new Uint8Array(first.id as ArrayBuffer)).toEqual(
      bytes("070707070707"),
    );
    expect(first.type).toBe("public-key");
    expect(first.transports).toEqual(["usb", "nfc"]);
    expect(new Uint8Array(second.id as ArrayBuffer)).toEqual(bytes("fbff"));
  });

  it("encodeAssertionResponse 把断言回应的四个缓冲都编成 base64url", () => {
    const encoded = encodeAssertionResponse({
      id: "BwcHBwcH",
      type: "public-key",
      rawId: bufferOf(7, 7, 7, 7, 7, 7),
      response: {
        clientDataJSON: bufferOf(0x7b, 0x7d),
        authenticatorData: bufferOf(0xa1, 0xa2, 0xa3),
        signature: bufferOf(0xfb, 0xff),
        userHandle: bufferOf(9, 9, 9, 9),
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential) as Record<string, unknown>;

    expect(encoded.id).toBe("BwcHBwcH");
    expect(encoded.type).toBe("public-key");
    expect(encoded.rawId).toBe("BwcHBwcH");
    const response = encoded.response as Record<string, unknown>;
    expect(response.clientDataJSON).toBe("e30");
    expect(response.authenticatorData).toBe("oaKj");
    expect(response.signature).toBe("-_8");
    // userHandle 是可发现凭证登录的必需项：go-webauthn 的 ValidatePasskeyLogin
    // 拿它去找账号，为空直接判失败。
    expect(response.userHandle).toBe("CQkJCQ");
  });

  it("userHandle 为 null 时整个字段不出现，而不是发一个 null", () => {
    // 后端那一侧是 `UserHandle URLEncodedBase64 json:"userHandle,omitempty"`；
    // 发 null 进去要走 UnmarshalJSON 的 null 分支，发 "" 会解成零长切片——
    // 两种都不如干脆不发，让缺失就是缺失。
    const encoded = encodeAssertionResponse({
      id: "c",
      type: "public-key",
      rawId: bufferOf(1),
      response: {
        clientDataJSON: bufferOf(2),
        authenticatorData: bufferOf(3),
        signature: bufferOf(4),
        userHandle: null,
      },
      getClientExtensionResults: () => ({}),
    } as unknown as PublicKeyCredential) as Record<string, unknown>;

    const response = encoded.response as Record<string, unknown>;
    expect("userHandle" in JSON.parse(JSON.stringify(response))).toBe(false);
  });

  it("编出来的整个对象 JSON.stringify 之后每个缓冲字段都是字符串", () => {
    // 缺了编码那一步时，JSON.stringify 会把 ArrayBuffer 变成 `{}`，
    // 而后端拿到 `{}` 只会回一句解析失败——这一条钉住的就是那种沉默的走形。
    const body = JSON.parse(
      JSON.stringify({
        credential: encodeAssertionResponse({
          id: "BwcHBwcH",
          type: "public-key",
          rawId: bufferOf(7, 7),
          response: {
            clientDataJSON: bufferOf(0x7b, 0x7d),
            authenticatorData: bufferOf(0xa1),
            signature: bufferOf(0xfb, 0xff),
            userHandle: bufferOf(9),
          },
          getClientExtensionResults: () => ({}),
        } as unknown as PublicKeyCredential),
      }),
    );
    const c = body.credential;
    for (const value of [
      c.rawId,
      c.response.clientDataJSON,
      c.response.authenticatorData,
      c.response.signature,
      c.response.userHandle,
    ]) {
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
