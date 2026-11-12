import {permissionKey} from "@/platform/authz/authorize";

/** The same canonical permission set supplies actual owner sessions and configured-access reports. */
export const ownerPortalPermissions=new Set([
 permissionKey("owner_portal","view"),permissionKey("owner_portal_property","view"),permissionKey("owner_statement","view")
]);
export function ownerPortalConfiguredCapabilities(){return{
 portal:ownerPortalPermissions.has(permissionKey("owner_portal","view")),statements:ownerPortalPermissions.has(permissionKey("owner_statement","view")),approvals:ownerPortalPermissions.has(permissionKey("approval","view")),documents:ownerPortalPermissions.has(permissionKey("document","view")),reports:ownerPortalPermissions.has(permissionKey("report","view"))
};}
