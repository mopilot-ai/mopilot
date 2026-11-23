// passkeys.node: the built-in browser's bridge to macOS's own passkey sheet (AuthenticationServices in web-browser
// mode), loaded into MoPilot's main process. It serves any website because the browser vouches for the origin,
// which needs the com.apple.developer.web-browser.public-key-credential entitlement; without it available() says so
// and main keeps Electron's own path. Main validates every request before it gets here (passkeyRequest.cjs).
// Built by scripts/build-passkeys.mjs. See docs/iab-passkeys.md.
#define NAPI_VERSION 8
#include <node_api.h>

#include <string>

#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Security/Security.h>

static NSString *const kEntitlement = @"com.apple.developer.web-browser.public-key-credential";

static bool HasEntitlement() {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return false;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)kEntitlement, nullptr);
  CFRelease(task);
  bool granted = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
  if (value) CFRelease(value);
  return granted;
}

static NSString *B64(NSData *data) { return data ? [data base64EncodedStringWithOptions:0] : (NSString *)[NSNull null]; }

static NSData *Bytes(id value) {
  return [value isKindOfClass:NSString.class] ? [[NSData alloc] initWithBase64EncodedString:value options:0] : nil;
}

static NSString *Text(id value) { return [value isKindOfClass:NSString.class] ? value : nil; }

API_AVAILABLE(macos(13.5))
@interface MPCPasskeyRequest : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic, strong) ASAuthorizationController *controller;
@property(nonatomic, weak) NSWindow *window;
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic) uint32_t handle;
@property(nonatomic) BOOL done;
@end

/** The requests whose sheet is up, by handle: they keep themselves (and their controller) alive until they answer. */
static NSMutableDictionary<NSNumber *, id> *live;
static uint32_t lastHandle = 0;

@implementation MPCPasskeyRequest

/** Answers main once (the first of a result or an error), then lets the request go. */
- (void)finish:(NSDictionary *)answer {
  if (self.done) return;
  self.done = YES;
  NSData *json = [NSJSONSerialization dataWithJSONObject:answer options:0 error:nil];
  char *copy = strdup(json ? (const char *)[[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] UTF8String]
                           : "{\"ok\":false,\"code\":1000}");
  if (napi_call_threadsafe_function(self.callback, copy, napi_tsfn_nonblocking) != napi_ok) free(copy);
  napi_release_threadsafe_function(self.callback, napi_tsfn_release);
  [live removeObjectForKey:@(self.handle)];
}

- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  return self.window ?: NSApp.keyWindow ?: NSApp.windows.firstObject;
}

- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  [self finish:@{@"ok" : @NO, @"code" : @(error.code), @"domain" : error.domain ?: @""}];
}

- (void)authorizationController:(ASAuthorizationController *)controller
    didCompleteWithAuthorization:(ASAuthorization *)authorization {
  id credential = authorization.credential;
  NSMutableDictionary *answer = [@{@"ok" : @YES} mutableCopy];
  // a platform credential says where it came from (this Mac, or a phone through hybrid); a security key is roaming
  ASAuthorizationPublicKeyCredentialAttachment attachment = ASAuthorizationPublicKeyCredentialAttachmentCrossPlatform;
  if ([credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialRegistration.class])
    attachment = [(ASAuthorizationPlatformPublicKeyCredentialRegistration *)credential attachment];
  else if ([credential isKindOfClass:ASAuthorizationPlatformPublicKeyCredentialAssertion.class])
    attachment = [(ASAuthorizationPlatformPublicKeyCredentialAssertion *)credential attachment];
  answer[@"attachment"] = attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
  if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialRegistration)]) {
    id<ASAuthorizationPublicKeyCredentialRegistration> r = credential;
    answer[@"kind"] = @"create";
    answer[@"credentialId"] = B64(r.credentialID);
    answer[@"clientDataJSON"] = B64(r.rawClientDataJSON);
    answer[@"attestationObject"] = B64(r.rawAttestationObject);
    if (@available(macOS 14.5, *)) {
      if ([credential isKindOfClass:ASAuthorizationSecurityKeyPublicKeyCredentialRegistration.class])
        answer[@"transports"] = [(ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *)credential transports] ?: @[];
    }
  } else if ([credential conformsToProtocol:@protocol(ASAuthorizationPublicKeyCredentialAssertion)]) {
    id<ASAuthorizationPublicKeyCredentialAssertion> a = credential;
    answer[@"kind"] = @"get";
    answer[@"credentialId"] = B64(a.credentialID);
    answer[@"clientDataJSON"] = B64(a.rawClientDataJSON);
    answer[@"authenticatorData"] = B64(a.rawAuthenticatorData);
    answer[@"signature"] = B64(a.signature);
    answer[@"userHandle"] = B64(a.userID);
  } else {
    answer = [@{@"ok" : @NO, @"code" : @1002, @"domain" : ASAuthorizationErrorDomain} mutableCopy];
  }
  [self finish:answer];
}

@end

static ASAuthorizationPublicKeyCredentialUserVerificationPreference Verification(id value) {
  if ([value isEqual:@"required"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
  if ([value isEqual:@"discouraged"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceDiscouraged;
  return ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred;
}

static ASAuthorizationPublicKeyCredentialAttestationKind Attestation(id value) {
  if ([value isEqual:@"direct"]) return ASAuthorizationPublicKeyCredentialAttestationKindDirect;
  if ([value isEqual:@"indirect"]) return ASAuthorizationPublicKeyCredentialAttestationKindIndirect;
  if ([value isEqual:@"enterprise"]) return ASAuthorizationPublicKeyCredentialAttestationKindEnterprise;
  return ASAuthorizationPublicKeyCredentialAttestationKindNone;
}

API_AVAILABLE(macos(13.5))
static NSArray *PlatformDescriptors(NSArray *list) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *d in list) {
    NSData *id_ = Bytes(d[@"id"]);
    if (id_) [out addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:id_]];
  }
  return out;
}

API_AVAILABLE(macos(14.4))
static NSArray *SecurityKeyDescriptors(NSArray *list) {
  NSMutableArray *out = [NSMutableArray array];
  for (NSDictionary *d in list) {
    NSData *id_ = Bytes(d[@"id"]);
    // a security key travels by USB, NFC or Bluetooth; a page's passkey transports (internal, hybrid) are not for it
    NSDictionary *known = @{
      @"usb" : ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB,
      @"nfc" : ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC,
      @"ble" : ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth,
    };
    NSMutableArray *transports = [NSMutableArray array];
    if ([d[@"transports"] isKindOfClass:NSArray.class])
      for (id t in d[@"transports"])
        if (known[t]) [transports addObject:known[t]];
    if (id_)
      [out addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:id_
                                                                                                transports:transports]];
  }
  return out;
}

/** The AuthenticationServices requests for one validated WebAuthn request (see passkeyRequest.cjs for its shape). */
API_AVAILABLE(macos(13.5))
static NSArray<ASAuthorizationRequest *> *BuildRequests(NSDictionary *q) {
  NSString *rpId = Text(q[@"rpId"]);
  NSString *origin = Text(q[@"origin"]);
  NSData *challenge = Bytes(q[@"challenge"]);
  if (!rpId || !origin || !challenge) return @[];
  ASPublicKeyCredentialClientData *clientData = [[ASPublicKeyCredentialClientData alloc] initWithChallenge:challenge
                                                                                                    origin:origin];
  if (Text(q[@"topOrigin"])) clientData.topOrigin = q[@"topOrigin"];
  clientData.crossOrigin = [q[@"crossOrigin"] boolValue] ? ASPublicKeyCredentialClientDataCrossOriginValueCrossOrigin
                                                          : ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
  BOOL hybrid = [q[@"hybrid"] boolValue];
  BOOL securityKey = NO;
  if (@available(macOS 14.4, *)) securityKey = [q[@"securityKey"] boolValue];
  NSMutableArray *requests = [NSMutableArray array];
  ASAuthorizationPlatformPublicKeyCredentialProvider *platform =
      [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
  if ([q[@"kind"] isEqual:@"create"]) {
    NSData *userId = Bytes(q[@"userId"]);
    NSString *name = Text(q[@"name"]);
    NSString *displayName = Text(q[@"displayName"]) ?: name;
    if (!userId || !name) return @[];
    if ([q[@"platform"] boolValue]) {
      ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *r =
          [platform createCredentialRegistrationRequestWithClientData:clientData name:name userID:userId];
      r.displayName = displayName;
      r.userVerificationPreference = Verification(q[@"userVerification"]);
      r.attestationPreference = Attestation(q[@"attestation"]);
      r.excludedCredentials = PlatformDescriptors(q[@"exclude"]);
      r.shouldShowHybridTransport = hybrid;
      [requests addObject:r];
    }
    if (@available(macOS 14.4, *)) {
      if (securityKey) {
        ASAuthorizationSecurityKeyPublicKeyCredentialProvider *keys =
            [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *r =
            [keys createCredentialRegistrationRequestWithClientData:clientData displayName:displayName name:name userID:userId];
        NSMutableArray *params = [NSMutableArray array];
        for (NSNumber *alg in q[@"algorithms"])
          [params addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:alg.integerValue]];
        r.credentialParameters = params;
        r.excludedCredentials = SecurityKeyDescriptors(q[@"exclude"]);
        r.userVerificationPreference = Verification(q[@"userVerification"]);
        r.attestationPreference = Attestation(q[@"attestation"]);
        r.residentKeyPreference = [q[@"residentKey"] isEqual:@"required"]
                                      ? ASAuthorizationPublicKeyCredentialResidentKeyPreferenceRequired
                                  : [q[@"residentKey"] isEqual:@"preferred"]
                                      ? ASAuthorizationPublicKeyCredentialResidentKeyPreferencePreferred
                                      : ASAuthorizationPublicKeyCredentialResidentKeyPreferenceDiscouraged;
        [requests addObject:r];
      }
    }
  } else {
    if ([q[@"platform"] boolValue]) {
      ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *r =
          [platform createCredentialAssertionRequestWithClientData:clientData];
      r.allowedCredentials = PlatformDescriptors(q[@"allow"]);
      r.userVerificationPreference = Verification(q[@"userVerification"]);
      r.shouldShowHybridTransport = hybrid;
      [requests addObject:r];
    }
    if (@available(macOS 14.4, *)) {
      if (securityKey) {
        ASAuthorizationSecurityKeyPublicKeyCredentialProvider *keys =
            [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
        ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *r =
            [keys createCredentialAssertionRequestWithClientData:clientData];
        r.allowedCredentials = SecurityKeyDescriptors(q[@"allow"]);
        r.userVerificationPreference = Verification(q[@"userVerification"]);
        [requests addObject:r];
      }
    }
  }
  return requests;
}

static void CallJs(napi_env env, napi_value js, void *, void *data) {
  char *json = (char *)data;
  if (env && js) {
    napi_value undefined, arg;
    napi_get_undefined(env, &undefined);
    napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &arg);
    napi_call_function(env, undefined, js, 1, &arg, nullptr);
  }
  free(json);
}

static napi_value Throw(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
}

/** available() → { entitlement, platform, securityKey }: what this Mac and this signature allow. */
static napi_value Available(napi_env env, napi_callback_info) {
  bool platform = false, securityKey = false;
  if (@available(macOS 13.5, *)) platform = true;
  if (@available(macOS 14.4, *)) securityKey = true;
  napi_value out, v;
  napi_create_object(env, &out);
  napi_get_boolean(env, HasEntitlement(), &v);
  napi_set_named_property(env, out, "entitlement", v);
  napi_get_boolean(env, platform, &v);
  napi_set_named_property(env, out, "platform", v);
  napi_get_boolean(env, securityKey, &v);
  napi_set_named_property(env, out, "securityKey", v);
  return out;
}

/** start(requestJson, nativeWindowHandle, callback(answerJson)) → handle; the callback runs exactly once. */
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 3) return Throw(env, "start(request, window, callback)");
  if (@available(macOS 13.5, *)) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, argv[0], nullptr, 0, &length) != napi_ok || length > 1 << 20)
      return Throw(env, "request must be a JSON string");
    std::string text(length + 1, '\0');
    napi_get_value_string_utf8(env, argv[0], text.data(), length + 1, &length);
    void *handleData = nullptr;
    size_t handleLength = 0;
    bool isBuffer = false;
    napi_is_buffer(env, argv[1], &isBuffer);
    if (isBuffer) napi_get_buffer_info(env, argv[1], &handleData, &handleLength);
    @try {
      NSData *json = [NSData dataWithBytes:text.data() length:length];
      NSDictionary *q = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
      if (![q isKindOfClass:NSDictionary.class]) return Throw(env, "request must be a JSON object");
      NSArray *requests = BuildRequests(q);
      if (!requests.count) return Throw(env, "no authenticator can serve this request");
      MPCPasskeyRequest *request = [MPCPasskeyRequest new];
      if (handleLength >= sizeof(void *)) {
        NSView *view = (__bridge NSView *)(*(void **)handleData);
        if ([view isKindOfClass:NSView.class]) request.window = view.window;
      }
      napi_value name;
      napi_create_string_utf8(env, "passkey", NAPI_AUTO_LENGTH, &name);
      napi_threadsafe_function callback;
      if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &callback) != napi_ok)
        return Throw(env, "callback must be a function");
      request.callback = callback;
      request.handle = ++lastHandle;
      if (!live) live = [NSMutableDictionary dictionary];
      live[@(request.handle)] = request;
      request.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
      request.controller.delegate = request;
      request.controller.presentationContextProvider = request;
      [request.controller performRequests];
      napi_value handle;
      napi_create_uint32(env, request.handle, &handle);
      return handle;
    } @catch (NSException *e) {
      return Throw(env, e.reason.UTF8String ?: "AuthenticationServices refused the request");
    }
  }
  return Throw(env, "passkeys need macOS 13.5 or later");
}

/** cancel(handle): closes the sheet; the request's callback then answers with the cancel error. */
static napi_value Cancel(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t handle = 0;
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &handle) != napi_ok) return nullptr;
  if (@available(macOS 13.5, *)) {
    MPCPasskeyRequest *request = live[@(handle)];
    @try {
      [request.controller cancel];
    } @catch (NSException *) {
      // no sheet to close: answer now, so the request and its callback don't wait for a delegate call that won't come
      [request finish:@{@"ok" : @NO, @"code" : @1001, @"domain" : ASAuthorizationErrorDomain}];
    }
  }
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "available", NAPI_AUTO_LENGTH, Available, nullptr, &fn);
  napi_set_named_property(env, exports, "available", fn);
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fn);
  napi_set_named_property(env, exports, "start", fn);
  napi_create_function(env, "cancel", NAPI_AUTO_LENGTH, Cancel, nullptr, &fn);
  napi_set_named_property(env, exports, "cancel", fn);
  return exports;
}
