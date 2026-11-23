// Test-only picture for the web preview: it draws the source address as an img.
export const Image = ({ source }: any) => <img src={source?.uri} alt="" />;
