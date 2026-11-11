"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {OnboardingBookingChannelsSnapshot,onboardingBookingChannelsSafeDraftSchema} from "../domain/onboarding-booking-channels";
import {OnboardingPropertyRecord} from "./onboarding-property-record";
import type {onboardingPropertyReviewSchema} from "../domain/onboarding-property";

type Draft=z.infer<typeof onboardingBookingChannelsSafeDraftSchema>;
type Parent=Pick<z.infer<typeof onboardingPropertyReviewSchema>,"owner"|"property">;
type Saved=OnboardingBookingChannelsSnapshot["channels"][number];
type Proposed=Extract<Draft["target"],{mode:"CONFIGURE"}>["channels"][number];
export function OnboardingBookingChannelsRecord({review,reason}:{review:Parent&{draft:Draft;previousChannels:OnboardingBookingChannelsSnapshot;channels?:OnboardingBookingChannelsSnapshot};reason:string}){
 const t=useTranslations("OnboardingWizard"),rows:readonly(Saved|Proposed)[]=review.channels?.channels??(review.draft.target.mode==="LINK"?review.previousChannels.channels:review.draft.target.channels);
 return <section className="resource-form" data-testid="onboarding-channels-record"><OnboardingPropertyRecord review={{owner:review.owner,property:review.property}} reason={reason}/><h3>{t("steps.BOOKING_CHANNELS")}</h3><p>{t("channels.connectionHint")}</p>{review.draft.target.mode==="CONFIGURE"&&<section className="resource-form" data-testid="onboarding-channels-before"><h4>{t("channels.before")}</h4><ChannelValues rows={review.previousChannels.channels}/></section>}<section className="resource-form"><h4>{t(review.channels?"channels.recorded":"channels.proposed")}</h4><ChannelValues rows={rows}/></section></section>;
}
export function ChannelValues({rows}:{rows:readonly(Saved|Proposed)[]}){
 const t=useTranslations("OnboardingWizard");
 return <>{rows.length===0&&<p>{t("channels.noChannels")}</p>}{rows.map((row,index)=><section key={"id"in row?row.id:row.sourceKey} className="resource-form" data-testid="onboarding-channel-record"><h4>{t("channels.channelNumber",{number:index+1})}</h4><dl className="onboarding-values">
  <div><dt>{t("channels.fields.displayName")}</dt><dd dir="auto">{row.displayName}</dd></div><div><dt>{t("channels.fields.sourceKey")}</dt><dd className="onboarding-private-text" dir="ltr">{row.sourceKey}</dd></div><div><dt>{t("channels.fields.externalListingId")}</dt><dd className="onboarding-private-text" dir="auto">{row.externalListingId??t("channels.none")}</dd></div><div><dt>{t("channels.fields.listingUrl")}</dt><dd className="onboarding-private-text" dir="ltr">{row.listingUrl??t("channels.none")}</dd></div><div><dt>{t("channels.fields.syncMode")}</dt><dd>{t("channels.syncModes."+row.syncMode)}</dd></div><div><dt>{t("channels.fields.importEnabled")}</dt><dd>{t(row.importEnabled?"channels.yes":"channels.no")}</dd></div><div><dt>{t("channels.fields.exportEnabled")}</dt><dd>{t(row.exportEnabled?"channels.yes":"channels.no")}</dd></div><div><dt>{t("channels.fields.status")}</dt><dd>{t("channels.statuses."+row.status)}</dd></div><div><dt>{t("channels.fields.syncEndpoint")}</dt><dd className="onboarding-private-text" dir="ltr">{"maskedSyncEndpoint"in row?row.maskedSyncEndpoint??t("channels.none"):t(row.hasSubmittedSyncEndpoint?"channels.endpointSubmitted":"channels.endpointRetained")}</dd></div>
 </dl></section>)}</>;
}
