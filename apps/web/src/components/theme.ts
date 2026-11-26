import { useSyncExternalStore } from "react";

const themeKey = "interview-studio-theme";
const listeners = new Set<() => void>();

export function readDarkMode() {
	try {
		return localStorage.getItem(themeKey) === "dark";
	} catch {
		return false;
	}
}

function getDarkMode() {
	return document.documentElement.classList.contains("dark");
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useDarkMode() {
	return useSyncExternalStore(subscribe, getDarkMode);
}

export function setDarkMode(dark: boolean) {
	if (getDarkMode() === dark) return;
	document.documentElement.classList.toggle("dark", dark);
	try {
		localStorage.setItem(themeKey, dark ? "dark" : "light");
	} catch {
		// The theme still applies when storage is unavailable.
	}
	for (const listener of listeners) listener();
}
