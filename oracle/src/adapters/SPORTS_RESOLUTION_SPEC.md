# Sports Market Resolution Specification

## Issue #915: Sports Data Adapter Resolution Mapping

This document defines how match results are mapped to Yes/No market outcomes for sports betting markets.

## Supported Market Types

### 1. Team Win Prediction
**Market question format**: "Will [Team Name] win against [Opponent]?"

**Resolution logic**:
- Extract final score from `match.stats.home_score` and `match.stats.away_score`
- Determine winner by score comparison
- Return `outcome = true` if selected team's score > opponent's score
- Return `outcome = false` otherwise (loss or draw)

**Example**:
```typescript
Market: "Will Lakers win?" (Lakers vs Celtics, Lakers = home team)
Final score: Lakers 105, Celtics 98
Resolution: outcome = true (105 > 98)

Market: "Will Celtics win?" (Lakers vs Celtics, Celtics = away team)
Final score: Lakers 105, Celtics 98
Resolution: outcome = false (98 < 105)
```

### 2. Draw/Tie Prediction
**Market question format**: "Will the match end in a draw?"

**Resolution logic**:
- Compare final scores
- Return `outcome = true` if `home_score === away_score`
- Return `outcome = false` otherwise

**Example**:
```typescript
Market: "Will match end in draw?" (Lakers vs Celtics)
Final score: Lakers 98, Celtics 98
Resolution: outcome = true (98 === 98)

Market: "Will match end in draw?" (Lakers vs Celtics)
Final score: Lakers 105, Celtics 98
Resolution: outcome = false (105 !== 98)
```

## Match Status Handling

### Finished Matches
- Status: `"finished"`, `"ft"`, or `status_code === 3`
- Resolution: Based on final score
- Confidence: Always `1.0` (deterministic)

### Cancelled Matches
- Status: `"cancelled"`, `"canceled"`, or `status_code === 5`
- Resolution: `outcome = false` with cancellation reason
- Market should be refunded according to contract logic

### Postponed Matches
- Status: `"postponed"` or `status_code === 4`
- Resolution: `outcome = false` with postponement reason
- Market should be refunded according to contract logic

### Incomplete Matches
- Status: `"notstarted"`, `"inplay"`, or other
- Resolution: Throws error - not ready for resolution
- Oracle should retry when match is finished

## Data Source: SportDataAPI

### API Endpoint
```
https://sportdataapi.com/api/v1/soccer/matches?apikey={key}&season_id={season}
```

### Response Structure
```typescript
interface SportDataApiMatch {
  match_id: number | string;
  status: string; // "finished", "postponed", "cancelled", etc.
  status_code?: number; // 3 = finished, 4 = postponed, 5 = cancelled
  home_team: { name: string };
  away_team: { name: string };
  stats?: {
    home_score?: number;
    away_score?: number;
  };
}
```

## Team Matching Algorithm

Teams are matched using case-insensitive substring matching:
```typescript
match.home_team.name.toLowerCase().includes(homeTeam.toLowerCase()) ||
homeTeam.toLowerCase().includes(match.home_team.name.toLowerCase())
```

This handles variations like:
- Full names vs abbreviations ("LA Lakers" matches "Lakers")
- Different capitalizations ("lakers" matches "Lakers")
- Partial names ("Real Madrid CF" matches "Real Madrid")

## Confidence Score

All finished sports matches return `confidence = 1.0` because:
- Score is objective and deterministic
- No ambiguity in win/loss/draw determination
- Source is authoritative final score

## Error Conditions

| Condition | Error Message | Action |
|-----------|--------------|--------|
| Match not found | "no matching game found for {home} vs {away}" | Check team names in market params |
| Match not finished | "match ... is not finished (status: {status})" | Retry when status changes to finished |
| Invalid market params | "missing/invalid sports params" | Market params must include sportKey, homeTeam, awayTeam, selectedTeam |

## Future Extensions

Potential additional market types:
- Over/under total score predictions
- Handicap/spread predictions
- First to score predictions
- Half-time result predictions
- Player performance predictions (goals, assists, etc.)

Each would require additional data fields from SportDataAPI and extended resolution logic.
