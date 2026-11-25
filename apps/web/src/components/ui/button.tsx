import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const buttonVariants = cva(
	"group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-colors duration-150 select-none disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed",
				outline:
					"border-input bg-background hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
				secondary:
					"bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
				ghost:
					"hover:bg-accent hover:text-accent-foreground active:bg-accent active:text-accent-foreground aria-expanded:bg-accent aria-expanded:text-accent-foreground",
				destructive:
					"bg-destructive text-destructive-foreground hover:border-current active:border-current",
				link: "text-accent-foreground underline underline-offset-4",
			},
			size: {
				default:
					"h-10 pointer-coarse:h-11 gap-2 px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				xs: "h-10 pointer-coarse:h-11 gap-1 px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
				sm: "h-10 pointer-coarse:h-11 gap-1 px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-12 gap-2 px-4 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
				icon: "size-10 pointer-coarse:size-11",
				"icon-xs":
					"size-10 pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
				"icon-sm":
					"size-10 pointer-coarse:size-11 in-data-[slot=button-group]:rounded-lg",
				"icon-lg": "size-12",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
	return (
		<ButtonPrimitive
			data-slot="button"
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
