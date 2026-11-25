import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const badgeVariants = cva(
	"group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3!",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
				secondary:
					"bg-secondary text-secondary-foreground [a]:hover:bg-accent [a]:hover:text-accent-foreground",
				destructive: "bg-error text-error-foreground",
				outline:
					"border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
				ghost: "hover:bg-accent hover:text-accent-foreground",
				link: "text-accent-foreground underline underline-offset-4",
				success: "bg-success text-success-foreground",
				warning: "bg-warning text-warning-foreground",
				info: "bg-info text-info-foreground",
				error: "bg-error text-error-foreground",
				muted: "bg-muted text-muted-foreground",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Badge({
	className,
	variant = "default",
	render,
	...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
	return useRender({
		defaultTagName: "span",
		props: mergeProps<"span">(
			{
				className: cn(badgeVariants({ variant }), className),
			},
			props,
		),
		render,
		state: {
			slot: "badge",
			variant,
		},
	});
}

export { Badge, badgeVariants };
