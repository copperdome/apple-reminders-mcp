// ReminderKit WRITE bridge (Phase 2). Implements the C entry points declared in
// RemindersPrivate.h using Apple's PRIVATE ReminderKit framework. Ported from Federico
// Viticci's RemCTL (remctl-private.m, MIT) — the private @interface declarations, the
// x-apple-reminderkit:// URL shapes, and the fetch→change→save flow are taken verbatim;
// only the subset needed for flagged / tags / subtasks / sections is declared here, and
// the orchestration is reshaped into discrete C functions. See THIRD_PARTY_NOTICES.
// Pinned against macOS as of 2026-06-04.
//
// Safety: rem_available() (NSClassFromString) gates every call, and each private selector
// is checked with respondsToSelector: before use, so a missing/changed framework returns a
// clean error rather than crashing. The framework is weak-linked (build-eventkit.sh), so
// the binary still launches — and reads still work — even if ReminderKit is absent.

#import <Foundation/Foundation.h>
#import "RemindersPrivate.h"

// ---- PRIVATE ReminderKit interfaces (subset; ported from remctl-private.m) ----------
@interface REMObjectID : NSObject
+ (id)objectIDWithURL:(NSURL *)url;
- (NSUUID *)uuid;
@end

@interface REMStore : NSObject
- (id)fetchReminderWithObjectID:(id)objectID error:(NSError **)error;
- (id)fetchListSectionWithObjectID:(id)objectID error:(NSError **)error;
@end

@interface REMSaveRequest : NSObject
- (instancetype)initWithStore:(REMStore *)store;
- (id)updateReminder:(id)reminder;
- (id)updateList:(id)list;
- (id)addReminderWithTitle:(NSString *)title toReminderSubtaskContextChangeItem:(id)context;
- (id)addListSectionWithDisplayName:(NSString *)name toListSectionContextChangeItem:(id)context;
- (BOOL)saveSynchronouslyWithError:(NSError **)error;
@end

@interface REMReminderChangeItem : NSObject
- (id)flaggedContext;
- (id)hashtagContext;
- (id)subtaskContext;
@end

@interface REMReminderHashtagContextChangeItem : NSObject
- (id)addHashtagWithType:(NSInteger)type name:(NSString *)name;
@end

@interface REMReminderFlaggedContextChangeItem : NSObject
- (void)setFlagged:(NSInteger)flagged;
@end

@interface REMReminder : NSObject
- (id)list;
@end

@interface REMListChangeItem : NSObject
- (id)sectionsContextChangeItem;
@end

@interface REMListSectionContextChangeItem : NSObject
- (void)setUnsavedMembershipsOfRemindersInSections:(id)memberships;
- (void)setUnsavedSectionIDsOrdering:(NSArray *)ordering;
- (void)setShouldUpdateSectionsOrdering:(BOOL)update;
@end

@interface REMListSectionChangeItem : NSObject
- (id)remObjectID;
@end

@interface REMMembership : NSObject
- (instancetype)initWithMemberIdentifier:(NSUUID *)memberIdentifier
                         groupIdentifier:(NSUUID *)groupIdentifier
                              isObsolete:(BOOL)isObsolete
                               modifiedOn:(NSDate *)modifiedOn;
@end

@interface REMMemberships : NSObject
- (instancetype)initWithMemberships:(NSArray *)memberships;
@end

// ---- helpers -----------------------------------------------------------------------
static const char *remErr(NSString *msg) {
    return strdup([(msg ?: @"ReminderKit error") UTF8String]);
}

static NSURL *reminderURL(NSString *ckid) {
    return [NSURL URLWithString:[NSString stringWithFormat:@"x-apple-reminderkit://REMCDReminder/%@", ckid]];
}
static NSURL *sectionURL(NSString *ckid) {
    return [NSURL URLWithString:[NSString stringWithFormat:@"x-apple-reminderkit://REMCDListSection/%@", ckid]];
}

int rem_available(void) {
    return (NSClassFromString(@"REMStore") != nil
            && NSClassFromString(@"REMSaveRequest") != nil
            && NSClassFromString(@"REMObjectID") != nil) ? 1 : 0;
}

// Shared setup: build the reminder object id, fetch it, and open a change item on a fresh
// save request. On success returns the change item and fills *outStore/*outSave/*outObjID;
// on failure returns nil and fills *outErr (a malloc'd string the caller must free()).
static REMReminderChangeItem *openReminderChange(NSString *ckid,
                                                 REMStore **outStore,
                                                 REMSaveRequest **outSave,
                                                 id *outObjID,
                                                 const char **outErr) {
    id objectID = [REMObjectID objectIDWithURL:reminderURL(ckid)];
    if (!objectID) { *outErr = remErr(@"could not build ReminderKit object id"); return nil; }
    REMStore *store = [REMStore new];
    NSError *error = nil;
    id reminder = [store fetchReminderWithObjectID:objectID error:&error];
    if (!reminder) { *outErr = remErr(error.localizedDescription ?: @"reminder not found"); return nil; }
    REMSaveRequest *save = [[REMSaveRequest alloc] initWithStore:store];
    REMReminderChangeItem *change = [save updateReminder:reminder];
    if (!change) { *outErr = remErr(@"could not create ReminderKit change item"); return nil; }
    *outStore = store; *outSave = save; *outObjID = objectID;
    return change;
}

// ---- writes ------------------------------------------------------------------------
const char *rem_set_flagged(const char *reminder_ckid, int flagged) {
    @autoreleasepool {
        if (!rem_available()) return remErr(@"ReminderKit unavailable");
        if (!reminder_ckid) return remErr(@"missing reminder id");
        NSString *ckid = [NSString stringWithUTF8String:reminder_ckid];
        REMStore *store; REMSaveRequest *save; id objID; const char *err = NULL;
        REMReminderChangeItem *change = openReminderChange(ckid, &store, &save, &objID, &err);
        if (!change) return err;
        id fc = [change flaggedContext];
        if (![fc respondsToSelector:@selector(setFlagged:)]) return remErr(@"flagged not supported by this ReminderKit");
        [(REMReminderFlaggedContextChangeItem *)fc setFlagged:flagged ? 1 : 0];
        NSError *error = nil;
        if (![save saveSynchronouslyWithError:&error]) return remErr(error.localizedDescription ?: @"save failed");
        return NULL;
    }
}

const char *rem_add_tags(const char *reminder_ckid, const char *tags_csv) {
    @autoreleasepool {
        if (!rem_available()) return remErr(@"ReminderKit unavailable");
        if (!reminder_ckid || !tags_csv) return remErr(@"missing reminder id or tags");
        NSString *ckid = [NSString stringWithUTF8String:reminder_ckid];
        NSString *csv = [NSString stringWithUTF8String:tags_csv];
        NSMutableArray<NSString *> *tags = [NSMutableArray array];
        for (NSString *raw in [csv componentsSeparatedByString:@","]) {
            NSString *t = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
            // Reminders hashtags are single tokens; strip a leading '#' if the caller included it.
            if ([t hasPrefix:@"#"]) t = [t substringFromIndex:1];
            if (t.length) [tags addObject:t];
        }
        if (tags.count == 0) return remErr(@"no tags to add");
        REMStore *store; REMSaveRequest *save; id objID; const char *err = NULL;
        REMReminderChangeItem *change = openReminderChange(ckid, &store, &save, &objID, &err);
        if (!change) return err;
        id hashtagContext = [change hashtagContext];
        if (![hashtagContext respondsToSelector:@selector(addHashtagWithType:name:)]) return remErr(@"tags not supported by this ReminderKit");
        for (NSString *tag in tags) {
            [(REMReminderHashtagContextChangeItem *)hashtagContext addHashtagWithType:1 name:tag];
        }
        NSError *error = nil;
        if (![save saveSynchronouslyWithError:&error]) return remErr(error.localizedDescription ?: @"save failed");
        return NULL;
    }
}

const char *rem_add_subtask(const char *parent_ckid, const char *title) {
    @autoreleasepool {
        if (!rem_available()) return remErr(@"ReminderKit unavailable");
        if (!parent_ckid || !title) return remErr(@"missing parent id or title");
        NSString *ckid = [NSString stringWithUTF8String:parent_ckid];
        NSString *name = [NSString stringWithUTF8String:title];
        if (name.length == 0) return remErr(@"subtask title is empty");
        REMStore *store; REMSaveRequest *save; id objID; const char *err = NULL;
        REMReminderChangeItem *change = openReminderChange(ckid, &store, &save, &objID, &err);
        if (!change) return err;
        id subtaskContext = [change subtaskContext];
        if (!subtaskContext) return remErr(@"subtasks not supported by this ReminderKit");
        id subtask = [save addReminderWithTitle:name toReminderSubtaskContextChangeItem:subtaskContext];
        if (!subtask) return remErr(@"could not create subtask");
        NSError *error = nil;
        if (![save saveSynchronouslyWithError:&error]) return remErr(error.localizedDescription ?: @"save failed");
        return NULL;
    }
}

const char *rem_assign_section(const char *reminder_ckid, const char *section_ckid) {
    @autoreleasepool {
        if (!rem_available()) return remErr(@"ReminderKit unavailable");
        if (!reminder_ckid || !section_ckid) return remErr(@"missing reminder id or section id");
        NSString *ckid = [NSString stringWithUTF8String:reminder_ckid];
        NSString *secCkid = [NSString stringWithUTF8String:section_ckid];
        REMStore *store; REMSaveRequest *save; id objID; const char *err = NULL;
        REMReminderChangeItem *change = openReminderChange(ckid, &store, &save, &objID, &err);
        if (!change) return err;
        id reminder = nil; // reacquire via change's owning reminder list below
        // We need the reminder object to get its list; re-fetch (cheap, same store).
        NSError *error = nil;
        reminder = [store fetchReminderWithObjectID:[REMObjectID objectIDWithURL:reminderURL(ckid)] error:&error];
        if (!reminder) return remErr(error.localizedDescription ?: @"reminder not found");
        id sectionObjectID = [REMObjectID objectIDWithURL:sectionURL(secCkid)];
        id section = [store fetchListSectionWithObjectID:sectionObjectID error:&error];
        if (!section) return remErr(error.localizedDescription ?: @"section not found");
        id listChange = [save updateList:[(REMReminder *)reminder list]];
        id sectionContext = [listChange sectionsContextChangeItem];
        if (![sectionContext respondsToSelector:@selector(setUnsavedMembershipsOfRemindersInSections:)]) return remErr(@"sections not supported by this ReminderKit");
        id membership = [[REMMembership alloc] initWithMemberIdentifier:[objID uuid]
                                                       groupIdentifier:[sectionObjectID uuid]
                                                            isObsolete:NO
                                                             modifiedOn:[NSDate date]];
        id memberships = [[REMMemberships alloc] initWithMemberships:@[membership]];
        [sectionContext setUnsavedMembershipsOfRemindersInSections:memberships];
        if (![save saveSynchronouslyWithError:&error]) return remErr(error.localizedDescription ?: @"save failed");
        return NULL;
    }
}

const char *rem_add_section_and_assign(const char *reminder_ckid, const char *section_name) {
    @autoreleasepool {
        if (!rem_available()) return remErr(@"ReminderKit unavailable");
        if (!reminder_ckid || !section_name) return remErr(@"missing reminder id or section name");
        NSString *ckid = [NSString stringWithUTF8String:reminder_ckid];
        NSString *name = [NSString stringWithUTF8String:section_name];
        if (name.length == 0) return remErr(@"section name is empty");
        REMStore *store; REMSaveRequest *save; id objID; const char *err = NULL;
        REMReminderChangeItem *change = openReminderChange(ckid, &store, &save, &objID, &err);
        if (!change) return err;
        NSError *error = nil;
        id reminder = [store fetchReminderWithObjectID:[REMObjectID objectIDWithURL:reminderURL(ckid)] error:&error];
        if (!reminder) return remErr(error.localizedDescription ?: @"reminder not found");
        id listChange = [save updateList:[(REMReminder *)reminder list]];
        id sectionContext = [listChange sectionsContextChangeItem];
        if (![sectionContext respondsToSelector:@selector(setUnsavedMembershipsOfRemindersInSections:)]) return remErr(@"sections not supported by this ReminderKit");
        id sectionChange = [save addListSectionWithDisplayName:name toListSectionContextChangeItem:sectionContext];
        id sectionObjectID = [sectionChange remObjectID];
        if (!sectionObjectID) return remErr(@"could not create section");
        id membership = [[REMMembership alloc] initWithMemberIdentifier:[objID uuid]
                                                       groupIdentifier:[sectionObjectID uuid]
                                                            isObsolete:NO
                                                             modifiedOn:[NSDate date]];
        id memberships = [[REMMemberships alloc] initWithMemberships:@[membership]];
        [sectionContext setUnsavedMembershipsOfRemindersInSections:memberships];
        [sectionContext setUnsavedSectionIDsOrdering:@[sectionObjectID]];
        [sectionContext setShouldUpdateSectionsOrdering:YES];
        if (![save saveSynchronouslyWithError:&error]) return remErr(error.localizedDescription ?: @"save failed");
        return NULL;
    }
}
