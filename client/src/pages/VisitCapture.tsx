import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, ArrowRight, Camera, Check, CheckCircle2,
  Clock, FileWarning, Hash, Navigation, Plus, Trash2, Upload, X,
} from "lucide-react";
import { navigate } from "@/lib/router";
import { useStore } from "@/lib/store";
import { SectionEyebrow, StatusPill, cx, useToast } from "@/components/ui";
import { captureGps, formatCoord } from "@/lib/geo";
import { reverseGeocode, applyGeocodeToForm } from "@/lib/geocode";
import { compressImage, formatBytes } from "@/lib/photo";
import { evidenceUrl, ApiError } from "@/lib/api";
import { useVisitDraft } from "@/lib/useVisitDraft";
import type {
  AcknowledgementMode, CheckSource, Grievance, HouseholdRelationship, PreferredLanguage,
  PriorAssistanceStatus, ProgrammeCategory, ProofOfResidenceStatus, TenureType,
  VisitEvidenceCategory, VisitForm, VisitHouseholdMember, VisitOutcome,
  VulnerabilityCategory,
} from "@/lib/types";

const STEPS = [
  "Arrival & location",
  "Identity",
  "Household",
  "Contact & language",
  "Dwelling & tenure",
  "Programme & vulnerability",
  "Prior assistance & proof",
  "Outcome & grievances",
  "Acknowledgement & submit",
] as const;

const READINESS_STEP: Record<string, number> = {
  "Confirm arrival": 0,
  "Worker declaration": 0,
  Village: 0,
  "Identity evidence": 1,
  "Household members": 2,
  "Primary phone": 3,
  "Programme source and reference": 5,
  "Prior assistance check": 6,
  "Visit outcome": 7,
  "Outcome note": 7,
  "Fieldworker name": 8,
  Signature: 8,
  "Witness name": 8,
  "Witness ID": 8,
  "Witness reason": 8,
};

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function blankForm(): VisitForm {
  return {
    schemaVersion: 3,
    arrivalConfirmed: false,
    visitType: "initial",
    gps: null,
    gpsOutsideBoundary: false,
    gpsLowAccuracy: false,
    gpsManualCorrection: false,
    gpsManualReason: "",
    gpsOriginalReading: null,
    arrivalAt: null,
    departedAt: null,
    intervieweeName: "",
    intervieweeRelationship: "head",
    intervieweeIsApplicant: false,
    workerDeclaration: false,
    villageObserved: "",
    wardObserved: "",
    municipalityObserved: "",
    locationSource: "observed",
    locationDiscrepancyNote: "",
    identityType: "South African ID",
    identityNumber: "",
    identityVerified: false,
    identityMatchesRegister: true,
    identitySource: "observed",
    identityNote: "",
    householdMembers: [],
    householdSource: "observed",
    undeclaredPersonsPresent: 0,
    undeclaredPersonsNote: "",
    householdObserved: 0,
    occupancyObservation: "",
    primaryPhone: "",
    primaryPhoneVerified: false,
    primaryPhoneSource: "declared",
    alternatePhone: "",
    preferredLanguage: "English",
    communicationConsent: false,
    dwellingType: "",
    dwellingCondition: "",
    dwellingSource: "observed",
    tenureType: "unknown",
