// The harnesses a chat can run on, as the side panel lists them (sidePanel.mjs): the new chat's select and the model menu's Harness rows, read when the panel loads and asked again each time the model menu opens, so a harness that wasn't ready at load (Codex still starting, a check that failed once) is offered once it is.

/** The harness the panel picked last, when MoPilot still offers it; else the first. */
export function pickHarness(/** @type {{ id: string }[]} */ list, /** @type {unknown} */ last) {
  return list.find((h) => h.id === last)?.id ?? list[0]?.id ?? '';
}

export class PanelHarnesses {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {any} o.select the new chat's harness select
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {(list: { id: string, label: string }[]) => void} o.setMenu the model menu's Harness rows
   * @param {(what: string, error: unknown) => void} o.log a failure, on the panel's error line
   */
  constructor(o) {
    this.o = o;
    /** the latest ask: an older answer never replaces it */
    this.latest = 0;
  }

  /** The list into the select (its pick kept when still offered, else `keep`'s or the first) and the model menu. */
  apply(/** @type {{ id: string, label: string }[]} */ harnesses, /** @type {unknown} */ keep) {
    const { document, select } = this.o;
    select.replaceChildren(
      ...harnesses.map((h) => {
        const option = document.createElement('option');
        option.value = h.id;
        option.textContent = h.label;
        return option;
      }),
    );
    select.value = pickHarness(harnesses, keep);
    this.o.setMenu(harnesses);
  }

  /** Asks again, keeping the harness the next new chat is on. An answer with none leaves the list as it was, rather than emptying the menu. */
  async refresh() {
    const ask = ++this.latest;
    try {
      const { harnesses = [] } = await this.o.request('harnesses');
      if (ask === this.latest && harnesses.length) this.apply(harnesses, this.o.select.value);
    } catch (e) {
      this.o.log('read the harnesses again', e);
    }
  }
}
