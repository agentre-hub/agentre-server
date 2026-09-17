package hashutil

import "testing"

func TestSHA256Hex(t *testing.T) {
	// 已知向量：sha256("abc") 的小写十六进制。
	const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if got := SHA256Hex("abc"); got != want {
		t.Fatalf("SHA256Hex(abc) = %q, want %q", got, want)
	}
	if got := SHA256Hex(""); len(got) != 64 {
		t.Fatalf("SHA256Hex(\"\") length = %d, want 64", len(got))
	}
}
