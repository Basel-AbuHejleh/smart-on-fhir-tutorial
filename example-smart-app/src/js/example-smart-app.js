/**
 * SMART on FHIR Example Application - Patient Data Extraction
 * 
 * This application demonstrates how to:
 * 1. Authenticate with a FHIR server using SMART on FHIR OAuth2 flow
 * 2. Retrieve patient demographic and clinical data from FHIR resources
 * 3. Extract observations (vitals, lab results) using LOINC codes
 * 4. Handle FHIR R4 data structures with proper error checking
 * 
 * SMART on FHIR enables apps to run within EHR systems (like Epic, Cerner)
 * and access patient data through standardized FHIR APIs.
 */
(function (window) {
  /**
   * Main data extraction function
   * 
   * Returns a jQuery Deferred promise that resolves with patient data
   * or rejects on error. This function orchestrates the entire FHIR
   * data retrieval process after OAuth2 authentication completes.
   * 
   * @returns {jQuery.Deferred} Promise that resolves with patient object
   */
  window.extractData = function () {
    // Create a deferred object to handle async data retrieval
    var ret = $.Deferred();

    /**
     * Error handler for FHIR data loading failures
     * 
     * This is called when:
     * - OAuth2 authentication fails
     * - FHIR API requests fail (network, auth, server errors)
     * - Required patient context is missing
     */
    function onError() {
      console.log('Loading error', arguments);
      ret.reject();
    }

    /**
     * Callback executed after successful SMART on FHIR OAuth2 authentication
     * 
     * This function is called when the SMART authorization flow completes.
     * At this point, we have an authenticated session and patient context.
     * 
     * @param {Object} smart - SMART client object with authenticated FHIR API access
     * @param {Object} smart.patient - Patient context from launch (contains patient ID)
     * @param {Object} smart.patient.api - FHIR API client for making requests
     */
    function onReady(smart) {
      // Verify that we have a patient context (required for patient-specific queries)
      if (smart.hasOwnProperty('patient')) {
        var patient = smart.patient;

        // Read the Patient resource to get demographics (name, gender, birthdate)
        var pt = patient.read();
        /**
         * Fetch all Observations for the patient matching specific LOINC codes
         * 
         * LOINC (Logical Observation Identifiers Names and Codes) is a standard
         * for identifying medical laboratory observations and clinical measurements.
         * 
         * LOINC codes being queried:
         * - 8302-2:  Body Height (cm/inches)
         * - 8462-4:  Diastolic Blood Pressure (mmHg)
         * - 8480-6:  Systolic Blood Pressure (mmHg)
         * - 2085-9:  HDL Cholesterol (mg/dL) - "good" cholesterol
         * - 2089-1:  LDL Cholesterol (mg/dL) - "bad" cholesterol
         * - 55284-4: Blood Pressure Panel (contains systolic/diastolic as components)
         * 
         * fetchAll() automatically handles FHIR pagination to retrieve all matching records
         */
        var obv = smart.patient.api.fetchAll({
          type: 'Observation',
          query: {
            code: {
              /**
               * $or means match ANY of these LOINC codes (union, not intersection)
               * 
               * Each LOINC code retrieves specific clinical observations:
               */
              $or: [
                'http://loinc.org|8302-2',   // Body Height - patient height measurement
                'http://loinc.org|8462-4',   // Diastolic BP - lower blood pressure number
                'http://loinc.org|8480-6',   // Systolic BP - upper blood pressure number
                'http://loinc.org|2085-9',   // HDL Cholesterol - "good" cholesterol level
                'http://loinc.org|2089-1',   // LDL Cholesterol - "bad" cholesterol level
                'http://loinc.org|55284-4'   // BP Panel - contains both systolic/diastolic as components
              ]
            }
          }
        });

        // Register error handler for any failures in patient or observation API calls
        $.when(pt, obv).fail(onError);

        /**
         * Process patient and observation data when BOTH API calls complete successfully
         * 
         * jQuery.when() waits for multiple promises and calls .done() when all resolve.
         * 
         * @param {Object} patient - FHIR Patient resource (R4 format)
         * @param {Array} obv - Array of FHIR Observation resources matching our query
         */
        $.when(pt, obv).done(function (patient, obv) {
          // Helper function from SMART client to group observations by LOINC code
          var byCodes = smart.byCodes(obv, 'code');

          // Extract administrative gender from patient resource
          // Possible values: "male", "female", "other", "unknown"
          var gender = patient.gender;

          // Initialize patient name components
          var fname = '';  // First/given name(s)
          var lname = '';  // Last/family name(s)

          /**
           * Extract patient name from FHIR HumanName datatype
           * 
           * FHIR R4 HumanName structure (patient.name is an array):
           * {
           *   "use": "official",           // Name context: official, usual, nickname, etc.
           *   "family": "AbuHejleh",        // Last name - can be string OR array!
           *   "given": ["Basheer", "M"],   // First/middle names - always array
           *   "prefix": ["Dr."],           // Title/prefix
           *   "suffix": ["Jr.", "MD"]     // Suffix
           * }
           * 
           * Patients can have multiple names (legal, nickname, maiden name, etc.)
           * We use name[0] which typically represents the official or primary name.
           */
          if (typeof patient.name[0] !== 'undefined') {
            // Join all given names with spaces: ["Basheer", "Ahmad"] → "Basheer Ahmad"
            fname = patient.name[0].given.join(' ');

            /**
             * CRITICAL: Handle family name as EITHER string OR array
             * 
             * Why both formats exist:
             * - US/UK systems: typically use string ("AbuHejleh", "Johnson")
             * - European systems: often use array for compound surnames
             *   Examples: ["van", "der", "Berg"], ["de", "la", "Cruz"]
             * 
             * This was the source of the original bug - assuming .join() on a string
             * caused "TypeError: patient.name[0].family.join is not a function"
             */
            lname = Array.isArray(patient.name[0].family)
              ? patient.name[0].family.join(' ')  // Array: ["van", "Berg"] → "van Berg"
              : patient.name[0].family;           // String: "AbuHejleh" → "AbuHejleh"
          }

          /**
           * Extract specific observations using LOINC codes
           * 
           * byCodes() returns an array of observations matching each LOINC code.
           * These arrays may be empty if no data exists for that code.
           */
          var height = byCodes('8302-2');        // Body height observations

          /**
           * Blood Pressure Extraction Strategy:
           * 
           * Try two approaches:
           * 1. PREFERRED: Extract from BP Panel (LOINC 55284-4) with components
           * 2. FALLBACK: Extract from individual systolic/diastolic observations
           * 
           * Different FHIR servers use different approaches for storing BP.
           */
          var systolicbp, diastolicbp;

          // Approach 1: Try to get BP from panel observations
          var bpPanelObservations = byCodes('55284-4');
          if (bpPanelObservations && bpPanelObservations.length > 0) {
            // Panel observations found - extract components
            systolicbp = getBloodPressureValue(bpPanelObservations, '8480-6');
            diastolicbp = getBloodPressureValue(bpPanelObservations, '8462-4');
          } else {
            // Approach 2: Fallback to individual observations
            var systolicObservations = byCodes('8480-6');
            var diastolicObservations = byCodes('8462-4');
            systolicbp = getQuantityValueAndUnit(systolicObservations[0]);
            diastolicbp = getQuantityValueAndUnit(diastolicObservations[0]);
          }

          var hdl = byCodes('2085-9');           // HDL "good" cholesterol
          var ldl = byCodes('2089-1');           // LDL "bad" cholesterol

          // Create a patient data object using our default structure
          var p = defaultPatient();

          // Populate with extracted FHIR data
          p.birthdate = patient.birthDate;  // Date in YYYY-MM-DD format
          p.gender = gender;
          p.fname = fname;
          p.lname = lname;
          p.height = getQuantityValueAndUnit(height[0]);  // e.g., "180 cm"

          // Only set blood pressure if values exist (they may be undefined)
          if (typeof systolicbp != 'undefined') {
            p.systolicbp = systolicbp;
          }

          if (typeof diastolicbp != 'undefined') {
            p.diastolicbp = diastolicbp;
          }

          // Cholesterol values (may be undefined if not available)
          p.hdl = getQuantityValueAndUnit(hdl[0]);  // e.g., "50 mg/dL"
          p.ldl = getQuantityValueAndUnit(ldl[0]);  // e.g., "120 mg/dL"

          // Resolve the promise with the populated patient data object
          ret.resolve(p);
        });
      } else {
        // No patient context available - possibly wrong launch type or error
        onError();
      }
    }

    /**
     * Initialize the SMART on FHIR OAuth2 authorization flow
     * 
     * This is the entry point that triggers OAuth authentication.
     * When ready, onReady is called; on error, onError is called.
     */
    FHIR.oauth2.ready(onReady, onError);

    // Return promise that will resolve with patient data or reject on error
    return ret.promise();

  };

  /**
   * Creates a default patient object with empty values
   * 
   * This structure matches what the UI expects to display.
   * All values are initialized as empty strings for safe rendering.
   * 
   * @returns {Object} Patient object with empty default values
   */
  function defaultPatient() {
    return {
      fname: { value: '' },
      lname: { value: '' },
      gender: { value: '' },
      birthdate: { value: '' },
      height: { value: '' },
      systolicbp: { value: '' },
      diastolicbp: { value: '' },
      ldl: { value: '' },
      hdl: { value: '' },
    };
  }

  /**
   * Extract blood pressure component from FHIR Blood Pressure Panel observations
   * 
   * Blood pressure in FHIR is often stored as a "panel" observation (LOINC 55284-4)
   * with two components:
   * - Systolic pressure (LOINC 8480-6)
   * - Diastolic pressure (LOINC 8462-4)
   * 
   * This function extracts one component from panel observations.
   * 
   * FHIR Observation structure for BP panel:
   * {
   *   "code": { "coding": [{ "code": "55284-4" }] },
   *   "component": [
   *     {
   *       "code": { "coding": [{ "code": "8480-6" }] },
   *       "valueQuantity": { "value": 120, "unit": "mmHg" }
   *     },
   *     {
   *       "code": { "coding": [{ "code": "8462-4" }] },
   *       "valueQuantity": { "value": 80, "unit": "mmHg" }
   *     }
   *   ]
   * }
   * 
   * @param {Array} BPObservations - Array of blood pressure panel observations
   * @param {string} typeOfPressure - LOINC code ('8480-6' for systolic, '8462-4' for diastolic)
   * @returns {string|undefined} Formatted value like "120 mmHg" or undefined
   */
  function getBloodPressureValue(BPObservations, typeOfPressure) {
    var formattedBPObservations = [];

    // Iterate through each blood pressure panel observation
    BPObservations.forEach(function (observation) {
      // Find the component matching our desired type (systolic or diastolic)
      var BP = observation.component.find(function (component) {
        // Search the coding array for the matching LOINC code
        return component.code.coding.find(function (coding) {
          return coding.code == typeOfPressure;
        });
      });

      // If we found the component, promote its value to the main observation level
      if (BP) {
        observation.valueQuantity = BP.valueQuantity;
        formattedBPObservations.push(observation);
      }
    });

    // Return the first (most recent) observation's value
    return getQuantityValueAndUnit(formattedBPObservations[0]);
  }

  /**
   * Extract and format a quantity value with its unit from a FHIR Observation
   * 
   * FHIR Observation.valueQuantity structure:
   * {
   *   "value": 180,
   *   "unit": "cm",
   *   "system": "http://unitsofmeasure.org",
   *   "code": "cm"
   * }
   * 
   * @param {Object} ob - FHIR Observation resource
   * @returns {string|undefined} Formatted string like "180 cm" or undefined if data missing
   */
  function getQuantityValueAndUnit(ob) {
    // Defensive checks to ensure all required fields exist
    if (typeof ob != 'undefined' &&
      typeof ob.valueQuantity != 'undefined' &&
      typeof ob.valueQuantity.value != 'undefined' &&
      typeof ob.valueQuantity.unit != 'undefined') {
      // Return formatted string: "value unit" (e.g., "180 cm", "120 mmHg")
      return ob.valueQuantity.value + ' ' + ob.valueQuantity.unit;
    } else {
      // Return undefined if observation or required fields are missing
      return undefined;
    }
  }

  /**
   * Render patient data to the UI by updating DOM elements
   * 
   * This function:
   * 1. Shows the patient data container (#holder)
   * 2. Hides the loading indicator (#loading)
   * 3. Populates all patient data fields into their respective HTML elements
   * 
   * @param {Object} p - Patient data object returned from extractData()
   */
  window.drawVisualization = function (p) {
    $('#holder').show();     // Display the data container
    $('#loading').hide();    // Hide the "Loading..." message

    // Populate each HTML element with corresponding patient data
    $('#fname').html(p.fname);           // First name
    $('#lname').html(p.lname);           // Last name
    $('#gender').html(p.gender);         // Gender (male/female/other/unknown)
    $('#birthdate').html(p.birthdate);   // Birth date (YYYY-MM-DD)
    $('#height').html(p.height);         // Height with unit (e.g., "180 cm")
    $('#systolicbp').html(p.systolicbp); // Systolic BP (e.g., "120 mmHg")
    $('#diastolicbp').html(p.diastolicbp); // Diastolic BP (e.g., "80 mmHg")
    $('#ldl').html(p.ldl);               // LDL cholesterol (e.g., "120 mg/dL")
    $('#hdl').html(p.hdl);               // HDL cholesterol (e.g., "50 mg/dL")
  };

})(window);
