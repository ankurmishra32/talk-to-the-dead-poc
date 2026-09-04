/**
 * Centralized user-facing UI strings for the "talk to the dead" PoC.
 *
 * Every hard-coded string that appears in the UI should live here so that:
 *  - text is consistent across the app,
 *  - a future locale layer (i18n) can translate a single source of truth,
 *  - components stay free of literal prose.
 *
 * Organization by screen/component, mirroring the directory structure.
 * For dynamic text, expose functions taking the interpolated values.
 */

export const strings = {
  common: {
    appName: "Remember",
    tagline: "A space to keep their voice alive",
    privacyNote: "Your conversations are private and stored securely.",
    save: "Save",
    cancel: "Cancel",
    edit: "Edit",
    delete: "Delete",
    close: "Close",
    back: "Back",
    next: "Next",
    loading: "Loading...",
    signOut: "Sign out",
  },

  auth: {
    welcomeBack: "Welcome back",
    createAccount: "Create your account",
    signInSubtitle: "Sign in to continue your conversations.",
    createAccountSubtitle: "Start remembering someone today.",
    emailLabel: "Email",
    emailPlaceholder: "you@example.com",
    passwordLabel: "Password",
    passwordPlaceholder: "Your password",
    signInButton: "Sign in",
    createAccountButton: "Create account",
    alreadyHaveAccount: "Already have an account? Sign in",
    noAccount: "Don't have an account? Sign up",
    genericError: "Something went wrong.",
    signup: {
      stepAccount: "Account",
      stepProfile: "Profile",
      createYourAccount: "Create your account",
      signupSubtitle: "Start your journey of keeping memories alive",
      confirmPasswordLabel: "Confirm password",
      confirmPasswordPlaceholder: "Re-enter your password",
      passwordsMismatch: "Passwords do not match",
      nextButton: "Next",
      backButton: "Back",
      buildYourProfile: "Build your profile",
      profileSubtitle: "Tell us a bit about yourself",
      nameLabel: "Display name",
      namePlaceholder: "e.g. Anurag",
      phoneLabel: "Phone (optional)",
      phonePlaceholder: "e.g. +91 98765 43210",
      hintLabel: "Who do you want to remember?",
      hintPlaceholder: "e.g. My grandmother who always told stories",
      completeButton: "Complete signup",
      alreadyHaveAccount: "Already have an account? Sign in",
    },
  },

  dashboard: {
    loading: "Loading...",
  },

  persona: {
    heading: "Remember someone",
    yourPeople: "Your people",
    loadingList: "Loading...",
    emptyList: "No one remembered yet. Create one below.",
    noRelationship: "",
    talk: "Talk",
    createNew: "Remember someone new",
    editHeading: (name: string) => `Edit "${name}"`,
    editHeadingGeneric: "Edit Persona",
    cancelEdit: "Cancel edit",
    editSubtitle: "Update their details below.",
    createSubtitle: "The more you share, the closer their voice will feel.",
    rememberThemButton: "Remember them",
    saveChangesButton: "Save changes",
    saving: "Saving...",
    signOutRequired: "You must be signed in to save a persona.",
    missingContext: (phrase: string) =>
      `Please specify when they would say "${phrase}" (the situation or trigger).`,
    confirmDeleteTitle: (name: string) => `Delete "${name}"?`,
    confirmDeleteMessage:
      "This persona and its conversation history will be removed and cannot be undone.",

    steps: {
      identity: "Who they were",
      speech: "How they spoke",
      evidence: "What they said",
      memory: "A memory",
    },

    relationships: [
      "Mother",
      "Father",
      "Grandparent",
      "Sibling",
      "Friend",
      "Partner",
      "Other",
    ] as const,

    languages: ["Hindi", "English", "Hinglish", "Other"] as const,

    speechStyles: [
      "Quiet",
      "Talkative",
      "Direct",
      "Playful",
      "Sarcastic",
      "Formal",
      "Emotional",
      "Blunt",
    ] as const,

    relationshipsEmptyOption: "Choose...",

    identity: {
      nameLabel: "What did you call them?",
      namePlaceholder: "e.g. Mom, Grandpa, Alex",
      relationshipLabel: "Who were they to you?",
      theyCalledYouLabel: "What did they call you?",
      theyCalledYouPlaceholder: "e.g. sweetie, kiddo, buddy",
    },

    speech: {
      languagesLabel: "Languages they spoke",
      mannerLabel: "How did they usually speak?",
    },

    evidence: {
      intro:
        "Share phrases they used and the specific situations when they said them. This helps the AI respond authentically instead of repeating catchphrases out of place.",
      exampleHeading: (n: number) => `Example ${n}`,
      remove: "Remove",
      phraseLabel: "What is something they used to say?",
      phrasePlaceholderPrimary:
        "\"That's too expensive — who's paying for that?\"",
      phrasePlaceholderSecondary: "\"Have you eaten yet?\"",
      contextLabel: "When would they say it?",
      contextPlaceholderPrimary:
        "\"When I mentioned buying something expensive\"",
      contextPlaceholderSecondary: "\"Whenever I came home from work\"",
      moreDetails: "More details",
      lessDetails: "Less details",
      meaningLabel: "What did they mean?",
      toneLabel: "How did they sound?",
      reactionLabel: "What would they typically do/say next?",
      meaningPlaceholderPrimary:
        "e.g. Disapproval: they thought I was wasting money",
      meaningPlaceholderSecondary: "e.g. Care: they wanted to know I was okay",
      tonePlaceholderPrimary: "e.g. Frustrated, direct",
      tonePlaceholderSecondary: "e.g. Warm, caring",
      reactionPlaceholderPrimary:
        "e.g. \"Scolds me for wasting money, asks what I needed it for\"",
      reactionPlaceholderSecondary:
        "e.g. \"Insists I sit down and rest before doing anything else\"",
      optionalSuffix: "(optional)",
      addAnother: "+ Add another example",
    },

    memory: {
      intro:
        "A moment, a habit, or anything that made them who they were. This helps the AI understand their personality beyond words.",
      textareaPlaceholder: "Tell us something you remember about them...",
    },
  },

  chat: {
    header: (name: string) => `Speaking with: ${name}`,
    disclaimer: "simulation / character — not a real person",
    viewProfile: "View profile",
    hideProfile: "Hide profile",
    memories: "Memories",
    hideMemories: "Hide memories",
    changePersona: "Change persona",
    emptyPrompt: (name: string) =>
      `Start the conversation. ${name.split(" ")[0]} will reply in the style you described.`,
    loadingConversation: "Loading conversation...",
    loadingEarlier: "Loading earlier messages...",
    typing: (name: string) => `${name.split(" ")[0]} is typing...`,
    composePlaceholder: "Type a message...",
    composeAria: "Message",
    send: "Send",
    cancel: "Cancel",
    messages: "Messages",
    sendFailure: "Request failed.",
    networkError: "Network error.",
    streamError: "Stream error.",
    streamInterrupted: "Stream interrupted.",
    emptyReply: "The model returned an empty reply.",
    signedOut: "You're signed out. Please sign in again.",
    sessionExpired: "Session expired. Please sign in again.",
    syncFailed: "Live conversation sync failed.",
    loadOlderFailed: "Failed to load older messages.",
    saveEditFailed: "Failed to save edit.",
    deleteMessageFailed: "Failed to delete message.",
    confirmDeleteTitle: "Delete this message?",
    confirmDeleteMessage:
      "This message will be removed from the conversation and cannot be undone.",
  },

  memoryInput: {
    addMemoryAction: "Add a memory",
    addMemoryFor: (name: string) => `for ${name}`,
    helper: "Helps the AI remember shared moments",
    textareaPlaceholder: "Write a memory here...",
    textareaPlaceholderFor: (name: string) =>
      `Write a memory, habit, or story about ${name}...`,
    saveMemory: "Save Memory",
    saving: "Saving...",
    savedSuccess: "Memory saved!",
    savedMemoriesHeading: (count: number) => `Saved Memories (${count})`,
    loadingList: "Loading saved memories...",
    emptyList: "No memories saved yet for this persona.",
    editMemoryAria: "Edit memory",
    confirmDeleteTitle: "Delete this memory?",
    confirmDeleteMessage: "This memory will be removed and cannot be undone.",
    saveFailed: "Failed to save memory.",
    updateFailed: "Failed to update memory.",
    deleteFailed: "Failed to delete memory.",
  },

  profile: {
    heading: (name: string) => `Persona Profile: ${name}`,
    loading: "Loading profile details...",
    relationship: "Relationship",
    theyCalledYou: "What they called you",
    languagesSpoken: "Languages Spoken",
    generalSpeech: "General Speech Manner",
    distinctiveSpeech: "Distinctive Situational Speech",
    memoryOfThem: "A Memory of Them",
    when: "When:",
    tone: "Tone:",
    meaning: "Meaning:",
  },

  messageBubble: {
    editAria: "Edit message",
    deleteAria: "Delete message",
  },

  confirm: {
    delete: "Delete",
    cancel: "Cancel",
  },
} as const;

export type Strings = typeof strings;