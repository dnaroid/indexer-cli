using UnityEngine;
using UnityEngine.InputSystem;

public class PlayerController : MonoBehaviour
{
    private Rigidbody rb;
    private PlayerInput playerInput;

    void Start()
    {
        rb = GetComponent<Rigidbody>();
        playerInput = GetComponent<PlayerInput>();
    }

    void Update()
    {
        float moveX = playerInput.actions["Move"].ReadValue<Vector2>().x;
        float moveZ = playerInput.actions["Move"].ReadValue<Vector2>().y;
        Vector3 movement = new Vector3(moveX, 0f, moveZ);
        rb.AddForce(movement * 10f);
    }
}
