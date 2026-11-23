// A DOM stand-in for expo-image: the picture shows as an img of its source address.
export const Image = ({ source }: any) => <img src={source?.uri} alt="" />;
