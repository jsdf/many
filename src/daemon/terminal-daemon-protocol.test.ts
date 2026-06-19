import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  type DaemonRequest,
  type DaemonMessage,
} from "./terminal-daemon-protocol.js";

describe("terminal-daemon framing", () => {
  it("round-trips a single message", () => {
    const msg: DaemonRequest = { reqId: 1, op: "ping" };
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(msg));
    expect(out).toEqual([msg]);
  });

  it("decodes multiple frames delivered in one chunk", () => {
    const a: DaemonRequest = { reqId: 1, op: "input", terminalId: "t1", data: "ls\n" };
    const b: DaemonRequest = { reqId: 2, op: "close", terminalId: "t1" };
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
    expect(decoder.push(chunk)).toEqual([a, b]);
  });

  it("reassembles a frame split across chunks", () => {
    const msg: DaemonMessage = {
      type: "event",
      subId: 7,
      event: { type: "data", data: "hello world" },
    };
    const frame = encodeFrame(msg);
    const decoder = new FrameDecoder();
    // Split mid-payload and mid-header to exercise both boundaries.
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 6))).toEqual([]);
    expect(decoder.push(frame.subarray(6))).toEqual([msg]);
  });

  it("preserves data with newlines and binary-ish control chars", () => {
    const data = "line1\nline2\r\n\x1b[2J\x07é end";
    const msg: DaemonMessage = { type: "event", subId: 0, event: { type: "data", data } };
    const decoder = new FrameDecoder();
    const out = decoder.push(encodeFrame(msg)) as DaemonMessage[];
    expect(out[0]).toEqual(msg);
    expect((out[0] as any).event.data).toBe(data);
  });

  it("handles concatenated partial then complete frames across pushes", () => {
    const a: DaemonRequest = { reqId: 1, op: "ping" };
    const b: DaemonRequest = { reqId: 2, op: "listAll" };
    const fa = encodeFrame(a);
    const fb = encodeFrame(b);
    const decoder = new FrameDecoder();
    // First push: all of A plus the first byte of B.
    expect(decoder.push(Buffer.concat([fa, fb.subarray(0, 1)]))).toEqual([a]);
    // Second push: the rest of B.
    expect(decoder.push(fb.subarray(1))).toEqual([b]);
  });
});
