import { cn } from "cn";
import type * as React from "react";

function Label({
	className,
	htmlFor,
	...props
}: React.ComponentProps<"label">) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: Callers pass a control ID through htmlFor or wrap the control.
		<label
			data-slot="label"
			htmlFor={htmlFor}
			className={cn(
				"flex items-center gap-2 text-sm leading-none font-semibold select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

export { Label };
