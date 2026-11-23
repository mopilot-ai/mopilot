// Test-only SwiftUI views for the web preview: the iOS-only menus render their children plainly.
import React from 'react';
import type { ReactNode } from 'react';
const Plain = ({ children }: { children?: ReactNode }) => <>{children}</>;
export const Host = Plain;
export const Menu = Plain;
export const Section = Plain;
export const Button = Plain;
export const Image = () => null;
