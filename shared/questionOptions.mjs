// One question-choice default for desktop and side-panel requests; only an explicit false disables a free-text Other answer.
export const offersOther = (question) => question.isOther !== false;
