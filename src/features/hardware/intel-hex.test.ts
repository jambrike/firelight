import { describe, expect, it } from "vitest";
import {
  IntelHexParseError,
  parseIntelHex,
} from "./intel-hex";
import { intelHexDocument, intelHexRecord } from "./testing/serial-mock";

function expectHexError(hex: string, code: IntelHexParseError["code"]): void {
  try {
    parseIntelHex(hex);
    throw new Error("Expected parseIntelHex to reject.");
  } catch (error) {
    expect(error).toBeInstanceOf(IntelHexParseError);
    expect((error as IntelHexParseError).code).toBe(code);
  }
}

describe("parseIntelHex", () => {
  it("decodes records into a deterministic dense erased-flash image", () => {
    const parsed = parseIntelHex(
      intelHexDocument(
        intelHexRecord(0, 0x00, [0x0c, 0x94, 0x34, 0x00]),
        intelHexRecord(8, 0x00, [0xaa, 0xbb]),
        intelHexRecord(0, 0x01, []),
      ),
    );

    expect(parsed).toMatchObject({
      dataByteCount: 6,
      startAddress: 0,
      endAddressExclusive: 10,
    });
    expect([...parsed.data]).toEqual([
      0x0c,
      0x94,
      0x34,
      0x00,
      0xff,
      0xff,
      0xff,
      0xff,
      0xaa,
      0xbb,
    ]);
  });

  it("supports standard segment, linear, and start-address records", () => {
    const parsed = parseIntelHex(
      intelHexDocument(
        intelHexRecord(0, 0x04, [0, 0]),
        intelHexRecord(0, 0x00, [1, 2]),
        intelHexRecord(0, 0x03, [0, 0, 0, 0]),
        intelHexRecord(0, 0x02, [0, 1]),
        intelHexRecord(0, 0x00, [3, 4]),
        intelHexRecord(0, 0x05, [0, 0, 0, 0]),
        intelHexRecord(0, 0x01, []),
      ),
    );

    expect(parsed.dataByteCount).toBe(4);
    expect([...parsed.data.slice(0, 2)]).toEqual([1, 2]);
    expect([...parsed.data.slice(16, 18)]).toEqual([3, 4]);
    expect([...parsed.data.slice(2, 16)]).toEqual(new Array<number>(14).fill(0xff));
  });

  it("rejects malformed records and checksum failures with line numbers", () => {
    expectHexError("not-a-record\n", "invalid-record");
    expectHexError(":01000000GGFF\n", "invalid-record");
    expectHexError(":0200000001FC\n", "invalid-record");

    const damaged = intelHexRecord(0, 0x00, [1, 2]).replace(/.$/, "0");
    try {
      parseIntelHex(intelHexDocument(damaged, intelHexRecord(0, 0x01, [])));
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-checksum", lineNumber: 1 });
    }
  });

  it("rejects ambiguous, incomplete, and unsupported documents", () => {
    expectHexError(" \n", "empty-input");
    expectHexError(intelHexDocument(intelHexRecord(0, 0x00, [1])), "missing-eof");
    expectHexError(intelHexDocument(intelHexRecord(0, 0x01, [])), "no-data");
    expectHexError(
      intelHexDocument(
        intelHexRecord(0, 0x00, [1]),
        intelHexRecord(0, 0x00, [1]),
        intelHexRecord(0, 0x01, []),
      ),
      "overlapping-data",
    );
    expectHexError(
      intelHexDocument(
        intelHexRecord(0, 0x00, [1]),
        intelHexRecord(0, 0x01, []),
        intelHexRecord(1, 0x00, [2]),
      ),
      "data-after-eof",
    );
    expectHexError(
      intelHexDocument(
        intelHexRecord(0, 0x00, [1]),
        intelHexRecord(0, 0x06, []),
        intelHexRecord(0, 0x01, []),
      ),
      "unsupported-record-type",
    );
  });

  it("enforces control-record shapes, address limits, and text limits", () => {
    expectHexError(
      intelHexDocument(
        intelHexRecord(0, 0x00, [1]),
        intelHexRecord(1, 0x01, []),
      ),
      "invalid-record-data",
    );
    expectHexError(
      intelHexDocument(
        intelHexRecord(0x7fff, 0x00, [1, 2]),
        intelHexRecord(0, 0x01, []),
      ),
      "address-out-of-range",
    );
    expect(() =>
      parseIntelHex(
        intelHexDocument(
          intelHexRecord(0, 0x00, [1]),
          intelHexRecord(0, 0x01, []),
        ),
        { maxTextBytes: 8 },
      ),
    ).toThrow(expect.objectContaining({ code: "text-too-large" }));
  });
});
