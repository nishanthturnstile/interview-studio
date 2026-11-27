import {
	eligibleInterviewCandidateSchema,
	hrInterviewDashboardSchema,
	hrInterviewSchema,
	type InterviewWorkspaceQuery,
	interviewTimelineSchema,
	interviewWorkspaceSchema,
} from "@studio/contracts";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { accessDenied, interviewRequest, retryInterviewRead } from "./api";

const listKey = ["hr-interviews", "list"] as const;
const eligibilityKey = ["hr-interviews", "eligibility"] as const;
export const feedbackReviewKey = ["hr-interviews", "feedback-reviews"] as const;
const listFreshness = 30_000;

export function hrDashboardQuery() {
	return queryOptions({
		queryKey: [...listKey, "dashboard"],
		queryFn: ({ signal }) =>
			interviewRequest(
				"/staff/interviews/dashboard",
				hrInterviewDashboardSchema,
				{ signal },
			),
		staleTime: listFreshness,
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) =>
			accessDenied(state.error) ? false : listFreshness,
		retry: retryInterviewRead,
	});
}

export function hrInterviewsQuery(filters: InterviewWorkspaceQuery) {
	return queryOptions({
		queryKey: [...listKey, filters],
		queryFn: ({ signal }) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(filters)) {
				if (value !== undefined && value !== "") query.set(key, String(value));
			}
			return interviewRequest(
				`/staff/interviews/workspace?${query}`,
				interviewWorkspaceSchema,
				{ signal },
			);
		},
		staleTime: listFreshness,
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) =>
			accessDenied(state.error) ? false : listFreshness,
		retry: retryInterviewRead,
	});
}

export function hrTimelineQuery(
	driveId: string,
	candidateId: string,
	page: number,
) {
	return queryOptions({
		queryKey: [...listKey, "timeline", driveId, candidateId, page],
		queryFn: ({ signal }) =>
			interviewRequest(
				`/staff/interviews/candidacies/${driveId}/${candidateId}/timeline?page=${page}`,
				interviewTimelineSchema,
				{ signal },
			),
		retry: retryInterviewRead,
		refetchOnWindowFocus: "always",
	});
}

export function hrBookingQuery(id: string) {
	return queryOptions({
		queryKey: ["hr-interviews", "booking", id],
		queryFn: ({ signal }) =>
			interviewRequest(`/staff/interviews/${id}`, hrInterviewSchema, {
				signal,
			}),
		staleTime: 8_000,
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
		retry: retryInterviewRead,
	});
}

export function bookingEligibilityQuery(driveId: string, candidateId: string) {
	return queryOptions({
		queryKey: [...eligibilityKey, driveId, candidateId],
		queryFn: ({ signal }) =>
			interviewRequest(
				`/staff/interviews/candidacies/${driveId}/${candidateId}/eligibility`,
				eligibleInterviewCandidateSchema,
				{ signal },
			),
		refetchOnWindowFocus: "always",
		refetchInterval: ({ state }) => (accessDenied(state.error) ? false : 8_000),
		retry: retryInterviewRead,
	});
}

export async function invalidateHrInterviews(
	client: QueryClient,
	bookingId?: string,
) {
	const list = { queryKey: listKey };
	const eligibility = { queryKey: eligibilityKey };
	const reviews = { queryKey: feedbackReviewKey };
	const booking = {
		queryKey: bookingId
			? hrBookingQuery(bookingId).queryKey
			: ["hr-interviews", "booking"],
	};
	const assessment = {
		queryKey: bookingId
			? ["hr-interviews", "assessment", bookingId]
			: ["hr-interviews", "assessment"],
	};
	// An in-flight read may have started before the write committed.
	await Promise.all([
		client.cancelQueries(list),
		client.cancelQueries(eligibility),
		client.cancelQueries(reviews),
		client.cancelQueries(booking),
		client.cancelQueries(assessment),
	]);
	await Promise.all([
		client.invalidateQueries(list),
		client.invalidateQueries(eligibility),
		client.invalidateQueries(reviews),
		client.invalidateQueries(booking),
		client.invalidateQueries(assessment),
	]);
}
