import { describe, expect, test } from "bun:test";
import { detectLang, messages } from "../src/i18n.ts";
import { wakeNote, WAKE_NOTE_MAX_BYTES } from "../src/wake.ts";

describe("detectLang", () => {
  test("OCS_LANG 显式覆盖优先", () => {
    expect(detectLang({ OCS_LANG: "zh", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(detectLang({ OCS_LANG: "en", LANG: "zh_CN.UTF-8" })).toBe("en");
  });
  test("locale 探测：zh 前缀走中文，其余英文", () => {
    expect(detectLang({ LANG: "zh_CN.UTF-8" })).toBe("zh");
    expect(detectLang({ LC_ALL: "zh_TW.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(detectLang({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(detectLang({ LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(detectLang({})).toBe("en");
  });
});

describe("messages 目录", () => {
  test("en/zh 目录键结构一致（漏译即红）", () => {
    const en = messages("en") as unknown as Record<string, unknown>;
    const zh = messages("zh") as unknown as Record<string, unknown>;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(typeof zh[key]).toBe(typeof en[key]);
    }
  });
});

describe("wakeNote 双语", () => {
  test("两种语言都恒 ≤5120 字节且含回复/读取命令", () => {
    for (const lang of ["en", "zh"] as const) {
      const note = wakeNote({
        channel: "a".repeat(64),
        seq: 999999,
        from: "n".repeat(64),
        body: "b".repeat(4096),
        receiver: "r".repeat(64),
        lang,
      });
      expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
      expect(note).toContain("ocs read");
      expect(note).toContain("ocs send");
    }
  });
});
