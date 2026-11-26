import { Moon } from "lucide-react";
import { setDarkMode, useDarkMode } from "@/components/theme";
import { Button } from "@/components/ui/button";

export function ThemeButton() {
	const dark = useDarkMode();

	return (
		<Button
			variant="ghost"
			type="button"
			aria-label="Dark mode"
			aria-pressed={dark}
			onClick={() => setDarkMode(!dark)}
		>
			<Moon aria-hidden="true" />
			<span className="hidden sm:inline">Dark mode</span>
		</Button>
	);
}
