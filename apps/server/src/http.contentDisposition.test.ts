import { describe, expect, it } from "vite-plus/test";

import { contentDispositionAttachment } from "./http.ts";

describe("contentDispositionAttachment", () => {
  it("provides a quoted ASCII fallback and an encoded Unicode filename", () => {
    expect(contentDispositionAttachment(`résumé "final's".pdf`)).toBe(
      "attachment; filename=\"re_sume_ _final's_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%27s%22.pdf",
    );
  });

  it("prevents header injection through the fallback and encoded filename", () => {
    const value = contentDispositionAttachment("report\r\nX-Evil: yes.txt");
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value).toContain("report__X-Evil: yes.txt");
    expect(value).toContain("report%0D%0AX-Evil%3A%20yes.txt");
  });
});
