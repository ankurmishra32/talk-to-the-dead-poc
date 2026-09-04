import { describe, it, expect } from "vitest";
import {
  readString,
  readStringArray,
  readSpeechExamples,
  type FirestoreFields,
} from "../lib/firestore";

function str(value: string): { stringValue: string } {
  return { stringValue: value };
}

describe("readString", () => {
  it("returns the string value for an existing field", () => {
    expect(readString({ name: str("Ammi") }, "name")).toBe("Ammi");
  });

  it("returns null for a missing field", () => {
    expect(readString({}, "name")).toBeNull();
  });

  it("returns null for a non-string field", () => {
    expect(readString({ x: { timestampValue: "2020-01-01" } }, "x")).toBeNull();
  });
});

describe("readStringArray", () => {
  it("returns values for an array field", () => {
    const fields: FirestoreFields = {
      languages: {
        arrayValue: {
          values: [str("Hindi"), str("English")],
        },
      },
    };
    expect(readStringArray(fields, "languages")).toEqual(["Hindi", "English"]);
  });

  it("returns an empty array for a missing field", () => {
    expect(readStringArray({}, "languages")).toEqual([]);
  });

  it("skips non-string entries in the array", () => {
    const fields: FirestoreFields = {
      x: {
        arrayValue: {
          values: [str("a"), { mapValue: { fields: {} } }],
        },
      },
    };
    expect(readStringArray(fields, "x")).toEqual(["a"]);
  });
});

describe("readSpeechExamples", () => {
  it("reads a structured example with all fields", () => {
    const fields: FirestoreFields = {
      speechExamples: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  context: str("expensive purchase"),
                  phrase: str("bill tumhara baap bharega"),
                  meaning: str("scolding about cost"),
                  tone: str("irritated"),
                  reaction: str("questions the expense"),
                },
              },
            },
          ],
        },
      },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([
      {
        context: "expensive purchase",
        phrase: "bill tumhara baap bharega",
        meaning: "scolding about cost",
        tone: "irritated",
        reaction: "questions the expense",
      },
    ]);
  });

  it("maps legacy trigger -> context and emotion -> tone", () => {
    const fields: FirestoreFields = {
      speechExamples: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  trigger: str("staying out late"),
                  phrase: str("itni raat kahan thi"),
                  emotion: str("worried"),
                },
              },
            },
          ],
        },
      },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([
      {
        context: "staying out late",
        phrase: "itni raat kahan thi",
        tone: "worried",
      },
    ]);
  });

  it("skips entries missing phrase or context", () => {
    const fields: FirestoreFields = {
      speechExamples: {
        arrayValue: {
          values: [
            { mapValue: { fields: { phrase: str("only phrase") } } },
            { mapValue: { fields: { context: str("only context") } } },
            { mapValue: { fields: {} } },
            {
              mapValue: {
                fields: { context: str("full"), phrase: str("both") },
              },
            },
          ],
        },
      },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([
      { context: "full", phrase: "both" },
    ]);
  });

  it("returns an empty array when the field is absent", () => {
    expect(readSpeechExamples({}, "speechExamples")).toEqual([]);
  });

  it("returns an empty array when the field is not an array", () => {
    const fields: FirestoreFields = {
      speechExamples: { stringValue: "nope" },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([]);
  });

  it("trims whitespace from phrase and context", () => {
    const fields: FirestoreFields = {
      speechExamples: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  context: str("  skip meals  "),
                  phrase: str("  khana kha liya?  "),
                },
              },
            },
          ],
        },
      },
    };
    expect(readSpeechExamples(fields, "speechExamples")).toEqual([
      { context: "skip meals", phrase: "khana kha liya?" },
    ]);
  });
});
