// DEV ONLY: the models the dev host's model menu adds to its two, so a sheet's list can have more rows than it shows (`run overflow`).

/** The extra models: `set(count)` makes `count` of them (0 puts the menu back), `list()` is what the menu adds. */
export function createModelMenu() {
  /** @type {{ id: string, label: string, efforts: object[], defaultEffort: null }[]} */
  let models = [];
  return {
    set: (/** @type {number} */ count) => {
      models = Array.from({ length: count }, (_, i) => ({
        id: `dev-extra-${i + 1}`,
        label: `Dev Model ${i + 1}`,
        efforts: [],
        defaultEffort: null,
      }));
    },
    list: () => models,
  };
}
