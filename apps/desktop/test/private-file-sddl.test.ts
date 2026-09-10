import { describe, expect, it } from "vitest";
import { unexpectedAllows } from "./fixtures/private-file";

/** The Windows privacy check reads SDDL (the fixture's native path); the parser is proven on every platform. */
describe("a private file's DACL, read as SDDL", () => {
  const owner = "S-1-5-21-1111111111-2222222222-3333333333-1001";

  it("accepts SYSTEM, Administrators, and the owner, in either spelling", () => {
    expect(unexpectedAllows("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)", owner)).toEqual([]);
    expect(unexpectedAllows("O:BAG:BAD:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)", owner)).toEqual([]);
  });

  it("names any other principal an allow entry lets in, and ignores deny entries", () => {
    expect(unexpectedAllows("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)(A;;FR;;;BU)", owner)).toEqual(["BU"]);
    expect(unexpectedAllows("D:PAI(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)(A;;FR;;;S-1-1-0)", owner)).toEqual(["S-1-1-0"]);
    expect(unexpectedAllows("D:PAI(D;;FR;;;BU)(A;;FA;;;SY)(A;;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)", owner)).toEqual([]);
  });

  it("reads nothing into a string with no DACL", () => {
    expect(unexpectedAllows("", owner)).toEqual([]);
    expect(unexpectedAllows("O:BAG:BA", owner)).toEqual([]);
  });
});
