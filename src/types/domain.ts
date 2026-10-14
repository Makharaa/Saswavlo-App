export type InstructionType =
  | "straight"
  | "left"
  | "right"
  | "stop"
  | "speed"
  | "warning";

export type DriveMode = "real" | "simulation";
export type DriveAssistMode = "practice" | "exam";
export type UserRole = "admin" | "driver";
export type ValidationLevel = "error" | "warning";
export type GeorgianTtsVoice = "ka-GE-EkaNeural" | "ka-GE-GiorgiNeural";
export type DrivingEventType =
  | "speeding"
  | "off_route"
  | "wrong_direction"
  | "checkpoint_missed"
  | "checkpoint_uncertain"
  | "checkpoint"
  | "session_started"
  | "session_finished"
  | "position";

export interface GeoPoint {
  lng: number;
  lat: number;
}

export interface GpsSample extends GeoPoint {
  accuracy: number | null;
  speedMps: number | null;
  heading: number | null;
  timestamp: number;
  speedSource?: "device" | "derived" | "unknown";
  headingSource?: "device" | "derived" | "unknown";
  speedConfidence?: "high" | "low" | "unknown";
  headingConfidence?: "high" | "low" | "unknown";
}

/** One acquisition or an explicit pause. Raw fixes are retained for replay. */
export interface DrivingTracePoint {
  observedAt: number;
  raw: GpsSample | null;
  sample: GpsSample | null;
  accepted: boolean;
  reason?: string | null;
  visible: boolean;
  /** Virtual clock for simulation; event timestamps always use observedAt. */
  evaluationTime?: number;
}

export interface SessionEvaluation {
  version: number;
  status: "replayed" | "legacy" | "incomplete";
  rejectedSamples: number;
  uncertainCheckpoints: number;
  missedCheckpoints: number;
  wrongDirectionEvents: number;
}

export interface RouteSpeedZone {
  id: string;
  startCoordinateIndex: number;
  endCoordinateIndex: number;
  speedLimit: number;
  label: string;
  /** Legacy fields accepted only while loading older saved route versions. */
  startPercent?: number;
  endPercent?: number;
}

export interface RouteValidationIssue {
  level: ValidationLevel;
  code: string;
  message: string;
}


export interface RouteCheckpoint extends GeoPoint {
  id?: number;
  routeId?: number;
  orderIndex: number;
  type: InstructionType;
  title: string;
  voice: string;
  ttsVoice: GeorgianTtsVoice;
  speedLimit: number | null;
  triggerMeters: number;
  /**
   * Optional index of the checkpoint on the authoritative route geometry.
   * Field Recorder stores this so overlapping/reversed road segments remain
   * distinguishable during real driving.
   */
  routeCoordinateIndex?: number | null;
  /** Training thresholds, not a statement of official examination rules. */
  evaluation?: {
    /** A spoken instruction marker, rather than a maneuver to grade. */
    instructionOnly?: boolean;
    stopSeconds?: number;
    stopRadiusMeters?: number;
    departureMeters?: number;
  };
}

export interface ExamRoute {
  id?: number;
  name: string;
  city: string;
  description: string;
  isPublished: boolean;
  waypoints: [number, number][];
  /** Exact leg boundaries on coordinates, including repeated road visits. */
  waypointCoordinateIndices?: number[];
  coordinates: [number, number][];
  speedZones: RouteSpeedZone[];
  checkpoints: RouteCheckpoint[];
  version: number;
  fieldTestedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface RouteDraft {
  name: string;
  city: string;
  description: string;
  isPublished: boolean;
  waypoints: [number, number][];
  waypointCoordinateIndices?: number[];
  coordinates: [number, number][];
  speedZones: RouteSpeedZone[];
  checkpoints: RouteCheckpoint[];
  fieldTestedAt?: string | null;
}

export interface DrivingEvent {
  id?: number;
  type: DrivingEventType;
  timestamp: number;
  lng?: number | null;
  lat?: number | null;
  value?: number | null;
  limitValue?: number | null;
  checkpointIndex?: number | null;
  note?: string;
}

export interface DrivingSessionResult {
  clientSessionId: string;
  routeId: number | null;
  routeVersion?: number | null;
  mode: DriveMode;
  assistMode: DriveAssistMode;
  startedAt: number;
  finishedAt: number;
  durationSeconds: number;
  distanceMeters: number;
  maxSpeedKmh: number;
  speedingEvents: number;
  offRouteEvents: number;
  checkpointsCompleted: number;
  checkpointsTotal: number;
  events: DrivingEvent[];
  evaluation?: SessionEvaluation;
  trace?: DrivingTracePoint[];
  traceComplete?: boolean;
}

export interface DrivingSessionSummary extends Omit<DrivingSessionResult, "events" | "trace"> {
  id: number;
  userId?: number | null;
  userName?: string | null;
  routeName: string | null;
  routeOriginId?: number | null;
  city: string | null;
  routeVersion?: number | null;
  createdAt: string;
}

export interface DrivingSessionDetail extends DrivingSessionSummary {
  events: DrivingEvent[];
  trace?: DrivingTracePoint[];
  routeSnapshot?: RouteDraft | null;
}



export interface RouteVersionSummary {
  id: number;
  routeId: number;
  version: number;
  editedBy: number | null;
  editedByName?: string | null;
  createdAt: string;
}

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  canUseRoutes: boolean;
}

export interface AdminUser extends AuthUser {
  createdAt: string;
  updatedAt: string;
}

export type AuditEntityType = "route" | "user" | "session" | "system";

export interface AuditLogEntry {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AnalyticsTimelinePoint {
  date: string;
  sessions: number;
  realSessions: number;
  simulationSessions: number;
}

export interface RouteAnalyticsRow {
  routeId: number | null;
  routeName: string;
  sessions: number;
  averageCompletion: number;
  speedingEvents: number;
  offRouteEvents: number;
  lastSessionAt: string | null;
}

export interface DriverAnalyticsRow {
  userId: number;
  userName: string;
  sessions: number;
  realSessions: number;
  averageCompletion: number;
  speedingEvents: number;
  offRouteEvents: number;
  lastSessionAt: string | null;
}

export interface AdminAnalyticsOverview {
  totals: {
    users: number;
    activeDrivers: number;
    routes: number;
    publishedRoutes: number;
    sessions: number;
    realSessions: number;
    simulationSessions: number;
    sessionsLast7Days: number;
    averageCompletion: number;
    speedingEvents: number;
    offRouteEvents: number;
  };
  timeline: AnalyticsTimelinePoint[];
  routes: RouteAnalyticsRow[];
  drivers: DriverAnalyticsRow[];
  recentSessions: DrivingSessionSummary[];
}
